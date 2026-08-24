use crate::error::{AppError, AppResult};
use crate::models::{ConfigRevisionView, ConfigSnapshot, ProfileServiceSummary, ProfileServiceView, ProfileView, ServiceMutation, ServiceRow};
use chrono::{DateTime, SecondsFormat, Utc};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, Row, params, types::Type};
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;
use uuid::Uuid;

/// Serialized SQLite repository that opens the existing Prisma database in place.
pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    /// Opens the production-compatible database and enables safe SQLite connection settings.
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;")?;
        Ok(Self { connection: Mutex::new(connection) })
    }

    /// Returns every service in stable creation order.
    pub fn list_services(&self) -> AppResult<Vec<ServiceRow>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(SERVICE_SELECT)
            .map_err(|error| AppError::internal("preparing service list", error))?;
        let rows = statement.query_map([], map_service_row)
            .map_err(|error| AppError::internal("querying services", error))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| AppError::internal("decoding services", error))
    }

    /// Returns one service by identifier.
    pub fn get_service(&self, service_id: &str) -> AppResult<Option<ServiceRow>> {
        let connection = self.connection.lock();
        connection.query_row(&format!("{SERVICE_SELECT_BASE} WHERE id=?1"), [service_id], map_service_row)
            .optional().map_err(|error| AppError::internal("querying service", error))
    }

    /// Finds registered services that use an exact port.
    pub fn services_by_port(&self, port: i64) -> AppResult<Vec<(String, String)>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare("SELECT id,name FROM Service WHERE port=?1")
            .map_err(|error| AppError::internal("preparing exact-port lookup", error))?;
        let rows = statement.query_map([port], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| AppError::internal("querying exact-port owners", error))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| AppError::internal("decoding exact-port owners", error))
    }

    /// Persists observed runtime state without changing desired state or configuration history.
    pub fn update_runtime(&self, service_id: &str, status: &str, pid: Option<u32>) -> AppResult<()> {
        let now = now_millis();
        self.connection.lock().execute(
            "UPDATE Service SET status=?2,pid=?3,updatedAt=?4 WHERE id=?1",
            params![service_id, status, pid.map(i64::from), now],
        ).map_err(|error| AppError::internal("updating service runtime", error))?;
        Ok(())
    }

    /// Persists whether the machine is meant to keep a service running.
    pub fn set_desired_status(&self, service_id: &str, desired_status: &str) -> AppResult<()> {
        self.connection.lock().execute(
            "UPDATE Service SET desiredStatus=?2,updatedAt=?3 WHERE id=?1",
            params![service_id, desired_status, now_millis()],
        ).map_err(|error| AppError::internal("updating desired service state", error))?;
        Ok(())
    }

    /// Returns all profiles with the nested override shape expected by the UI.
    pub fn list_profiles(&self) -> AppResult<Vec<ProfileView>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare("SELECT id,name,isActive,createdAt,updatedAt FROM RunProfile ORDER BY createdAt ASC")
            .map_err(|error| AppError::internal("preparing profile list", error))?;
        let rows = statement.query_map([], profile_from_row)
            .map_err(|error| AppError::internal("querying profiles", error))?;
        let mut profiles = rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| AppError::internal("decoding profiles", error))?;
        for profile in &mut profiles {
            profile.services = profile_services(&connection, &profile.id)?;
        }
        Ok(profiles)
    }

    /// Returns the active profile and its nested service overrides.
    pub fn active_profile(&self) -> AppResult<Option<ProfileView>> {
        Ok(self.list_profiles()?.into_iter().find(|profile| profile.is_active))
    }

    /// Returns one profile with its overrides.
    pub fn get_profile(&self, profile_id: &str) -> AppResult<Option<ProfileView>> {
        Ok(self.list_profiles()?.into_iter().find(|profile| profile.id == profile_id))
    }

    /// Returns the active profile override for a service.
    pub fn active_override(&self, service_id: &str) -> AppResult<Option<ProfileServiceView>> {
        let Some(profile) = self.active_profile()? else { return Ok(None) };
        Ok(profile.services.into_iter().find(|entry| entry.service_id == service_id))
    }

    /// Creates a service, mirrors its override into every profile, and records one atomic revision.
    pub fn create_service(&self, mutation: &ServiceMutation, reason: &str, author: &str) -> AppResult<ServiceRow> {
        let name = required_text(mutation.name.as_deref(), "Name is required")?;
        let command = required_text(mutation.command.as_deref(), "Command is required")?;
        let id = new_id();
        let timestamp = now_millis();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(|error| AppError::internal("starting service create transaction", error))?;
        transaction.execute(
            "INSERT INTO Service (id,name,description,command,port,noPort,wsl,cudaDevice,minFreeVramMb,startOnBoot,pid,status,desiredStatus,createdAt,updatedAt) VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,?8,0,NULL,'stopped','stopped',?9,?9)",
            params![id, name, flatten_string(&mutation.description), command, flatten_option(&mutation.port), bool_i64(mutation.no_port.unwrap_or(false)), bool_i64(mutation.wsl.unwrap_or(false)), flatten_option(&mutation.min_free_vram_mb), timestamp],
        ).map_err(|error| AppError::internal("creating service", error))?;
        let profiles = profile_ids(&transaction)?;
        for (profile_id, _) in &profiles {
            transaction.execute(
                "INSERT INTO RunProfileService (id,profileId,serviceId,cudaDevice,startOnBoot,autoRestart) VALUES (?1,?2,?3,?4,?5,?6)",
                params![new_id(), profile_id, id, flatten_string(&mutation.cuda_device), bool_i64(mutation.start_on_boot.unwrap_or(false)), bool_i64(mutation.auto_restart.unwrap_or(false))],
            ).map_err(|error| AppError::internal("creating profile service override", error))?;
        }
        let snapshot = snapshot_in_transaction(&transaction, &id, None)?;
        insert_revision(&transaction, &id, name, "create", author, reason, None, snapshot.as_ref(), None)?;
        transaction.commit().map_err(|error| AppError::internal("committing service create", error))?;
        drop(connection);
        self.get_service(&id)?.ok_or_else(|| AppError::internal("reading created service", "row disappeared"))
    }

    /// Updates global and active-profile fields atomically and appends a revision only when values change.
    #[allow(clippy::too_many_arguments)]
    pub fn update_service(&self, service_id: &str, mutation: &ServiceMutation, reason: &str, author: &str, change_type: &str, reverted_from: Option<&str>) -> AppResult<ServiceRow> {
        let current = self.get_service(service_id)?.ok_or_else(|| AppError::NotFound("Service not found".into()))?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(|error| AppError::internal("starting service update transaction", error))?;
        let before = snapshot_in_transaction(&transaction, service_id, None)?;
        let merged = merge_service_mutation(&current, mutation);
        transaction.execute(
            "UPDATE Service SET name=?2,description=?3,command=?4,port=?5,noPort=?6,wsl=?7,minFreeVramMb=?8,status=?9,pid=?10,updatedAt=?11 WHERE id=?1",
            params![service_id, merged.name, merged.description, merged.command, merged.port, bool_i64(merged.no_port), bool_i64(merged.wsl), merged.min_free_vram_mb, current.status, current.pid, now_millis()],
        ).map_err(|error| AppError::internal("updating service", error))?;
        update_active_override(&transaction, service_id, mutation)?;
        let after = snapshot_in_transaction(&transaction, service_id, None)?;
        if before != after {
            insert_revision(&transaction, service_id, &merged.name, change_type, author, reason, before.as_ref(), after.as_ref(), reverted_from)?;
        }
        transaction.commit().map_err(|error| AppError::internal("committing service update", error))?;
        drop(connection);
        self.get_service(service_id)?.ok_or_else(|| AppError::internal("reading updated service", "row disappeared"))
    }

    /// Deletes a service and retains its immutable delete revision.
    pub fn delete_service(&self, service_id: &str, reason: &str, author: &str) -> AppResult<()> {
        let current = self.get_service(service_id)?.ok_or_else(|| AppError::NotFound("Service not found".into()))?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(|error| AppError::internal("starting service delete transaction", error))?;
        let before = snapshot_in_transaction(&transaction, service_id, None)?;
        transaction.execute("DELETE FROM Service WHERE id=?1", [service_id])
            .map_err(|error| AppError::internal("deleting service", error))?;
        insert_revision(&transaction, service_id, &current.name, "delete", author, reason, before.as_ref(), None, None)?;
        transaction.commit().map_err(|error| AppError::internal("committing service delete", error))?;
        Ok(())
    }

    /// Lists decoded service revisions newest first with a bounded limit.
    pub fn list_revisions(&self, service_id: &str, limit: usize) -> AppResult<Vec<ConfigRevisionView>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare("SELECT id,serviceId,serviceName,profileId,profileName,changeType,author,reason,snapshot,previous,changedFields,revertedFromRevisionId,createdAt FROM ConfigRevision WHERE serviceId=?1 ORDER BY createdAt DESC LIMIT ?2")
            .map_err(|error| AppError::internal("preparing revision list", error))?;
        let rows = statement.query_map(params![service_id, limit as i64], map_revision_row)
            .map_err(|error| AppError::internal("querying revisions", error))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| AppError::internal("decoding revisions", error))
    }

    /// Finds a revision only when it belongs to the requested service.
    pub fn get_revision(&self, service_id: &str, revision_id: &str) -> AppResult<Option<ConfigRevisionView>> {
        let connection = self.connection.lock();
        connection.query_row("SELECT id,serviceId,serviceName,profileId,profileName,changeType,author,reason,snapshot,previous,changedFields,revertedFromRevisionId,createdAt FROM ConfigRevision WHERE id=?1 AND serviceId=?2", params![revision_id, service_id], map_revision_row)
            .optional().map_err(|error| AppError::internal("querying revision", error))
    }

    /// Creates a profile and clones all active overrides in one transaction.
    pub fn create_profile(&self, name: &str) -> AppResult<ProfileView> {
        let id = new_id();
        let timestamp = now_millis();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(|error| AppError::internal("starting profile create transaction", error))?;
        transaction.execute("INSERT INTO RunProfile (id,name,isActive,createdAt,updatedAt) VALUES (?1,?2,0,?3,?3)", params![id, name, timestamp])
            .map_err(|error| AppError::internal("creating profile", error))?;
        let active_id: Option<String> = transaction.query_row("SELECT id FROM RunProfile WHERE isActive=1 LIMIT 1", [], |row| row.get(0)).optional()
            .map_err(|error| AppError::internal("querying active profile for clone", error))?;
        if let Some(active_id) = active_id {
            transaction.execute("INSERT INTO RunProfileService (id,profileId,serviceId,cudaDevice,startOnBoot,autoRestart) SELECT lower(hex(randomblob(16))),?1,serviceId,cudaDevice,startOnBoot,autoRestart FROM RunProfileService WHERE profileId=?2", params![id, active_id])
                .map_err(|error| AppError::internal("cloning profile overrides", error))?;
        }
        transaction.commit().map_err(|error| AppError::internal("committing profile create", error))?;
        drop(connection);
        self.get_profile(&id)?.ok_or_else(|| AppError::internal("reading created profile", "row disappeared"))
    }

    /// Renames a profile while preserving its services and active state.
    pub fn rename_profile(&self, profile_id: &str, name: &str) -> AppResult<ProfileView> {
        let affected = self.connection.lock().execute("UPDATE RunProfile SET name=?2,updatedAt=?3 WHERE id=?1", params![profile_id, name, now_millis()])
            .map_err(|error| AppError::internal("renaming profile", error))?;
        if affected == 0 { return Err(AppError::NotFound(format!("Profile not found: {profile_id}"))); }
        self.get_profile(profile_id)?.ok_or_else(|| AppError::internal("reading renamed profile", "row disappeared"))
    }

    /// Deletes a non-active profile when at least one other profile remains.
    pub fn delete_profile(&self, profile_id: &str) -> AppResult<()> {
        let profile = self.get_profile(profile_id)?.ok_or_else(|| AppError::NotFound(format!("Profile not found: {profile_id}")))?;
        if profile.is_active { return Err(AppError::Conflict("Cannot delete the active profile. Switch to another profile first.".into())); }
        if self.list_profiles()?.len() <= 1 { return Err(AppError::Conflict("Cannot delete the last remaining profile.".into())); }
        self.connection.lock().execute("DELETE FROM RunProfile WHERE id=?1", [profile_id])
            .map_err(|error| AppError::internal("deleting profile", error))?;
        Ok(())
    }

    /// Marks exactly one profile active and returns its hydrated state.
    pub fn set_active_profile(&self, profile_id: &str) -> AppResult<ProfileView> {
        if self.get_profile(profile_id)?.is_none() { return Err(AppError::NotFound(format!("Profile not found: {profile_id}"))); }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(|error| AppError::internal("starting profile switch transaction", error))?;
        transaction.execute("UPDATE RunProfile SET isActive=0", []).map_err(|error| AppError::internal("clearing active profile", error))?;
        transaction.execute("UPDATE RunProfile SET isActive=1,updatedAt=?2 WHERE id=?1", params![profile_id, now_millis()])
            .map_err(|error| AppError::internal("activating profile", error))?;
        transaction.commit().map_err(|error| AppError::internal("committing active profile", error))?;
        drop(connection);
        self.get_profile(profile_id)?.ok_or_else(|| AppError::internal("reading active profile", "row disappeared"))
    }

    /// Updates one profile override and records its effective configuration revision.
    #[allow(clippy::too_many_arguments)]
    pub fn update_profile_override(&self, profile_id: &str, service_id: &str, cuda_device: Option<Option<String>>, start_on_boot: Option<bool>, auto_restart: Option<bool>, reason: &str, author: &str) -> AppResult<ProfileServiceView> {
        let profile = self.get_profile(profile_id)?.ok_or_else(|| AppError::NotFound(format!("Profile not found: {profile_id}")))?;
        let service = self.get_service(service_id)?.ok_or_else(|| AppError::NotFound("Service not found".into()))?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(|error| AppError::internal("starting profile override transaction", error))?;
        let before = snapshot_in_transaction(&transaction, service_id, Some(profile_id))?;
        let current = profile.services.iter().find(|entry| entry.service_id == service_id);
        transaction.execute(
            "INSERT INTO RunProfileService (id,profileId,serviceId,cudaDevice,startOnBoot,autoRestart) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(profileId,serviceId) DO UPDATE SET cudaDevice=excluded.cudaDevice,startOnBoot=excluded.startOnBoot,autoRestart=excluded.autoRestart",
            params![current.map(|entry| entry.id.clone()).unwrap_or_else(new_id), profile_id, service_id, cuda_device.clone().unwrap_or_else(|| current.and_then(|entry| entry.cuda_device.clone())), bool_i64(start_on_boot.unwrap_or_else(|| current.map(|entry| entry.start_on_boot).unwrap_or(false))), bool_i64(auto_restart.unwrap_or_else(|| current.map(|entry| entry.auto_restart).unwrap_or(false)))],
        ).map_err(|error| AppError::internal("updating profile override", error))?;
        let after = snapshot_in_transaction(&transaction, service_id, Some(profile_id))?;
        if before != after { insert_revision(&transaction, service_id, &service.name, "update", author, reason, before.as_ref(), after.as_ref(), None)?; }
        transaction.commit().map_err(|error| AppError::internal("committing profile override", error))?;
        drop(connection);
        self.get_profile(profile_id)?.and_then(|view| view.services.into_iter().find(|entry| entry.service_id == service_id))
            .ok_or_else(|| AppError::internal("reading updated profile override", "row disappeared"))
    }
}

const SERVICE_SELECT_BASE: &str = "SELECT id,name,description,command,port,noPort,wsl,cudaDevice,minFreeVramMb,startOnBoot,pid,status,desiredStatus,createdAt,updatedAt FROM Service";
const SERVICE_SELECT: &str = "SELECT id,name,description,command,port,noPort,wsl,cudaDevice,minFreeVramMb,startOnBoot,pid,status,desiredStatus,createdAt,updatedAt FROM Service ORDER BY createdAt ASC";

/// Decodes one SQLite service row.
fn map_service_row(row: &Row<'_>) -> rusqlite::Result<ServiceRow> {
    Ok(ServiceRow { id: row.get(0)?, name: row.get(1)?, description: row.get(2)?, command: row.get(3)?, port: row.get(4)?, no_port: row.get::<_, i64>(5)? != 0, wsl: row.get::<_, i64>(6)? != 0, cuda_device: row.get(7)?, min_free_vram_mb: row.get(8)?, start_on_boot: row.get::<_, i64>(9)? != 0, pid: row.get(10)?, status: row.get(11)?, desired_status: row.get(12)?, created_at: decode_datetime(row, 13)?, updated_at: decode_datetime(row, 14)? })
}

/// Decodes a profile without its nested overrides.
fn profile_from_row(row: &Row<'_>) -> rusqlite::Result<ProfileView> {
    Ok(ProfileView { id: row.get(0)?, name: row.get(1)?, is_active: row.get::<_, i64>(2)? != 0, created_at: decode_datetime(row, 3)?, updated_at: decode_datetime(row, 4)?, services: Vec::new() })
}

/// Loads the service overrides nested beneath one profile.
fn profile_services(connection: &Connection, profile_id: &str) -> AppResult<Vec<ProfileServiceView>> {
    let mut statement = connection.prepare("SELECT r.id,r.profileId,r.serviceId,r.cudaDevice,r.startOnBoot,r.autoRestart,s.name,s.port FROM RunProfileService r JOIN Service s ON s.id=r.serviceId WHERE r.profileId=?1 ORDER BY s.createdAt ASC")
        .map_err(|error| AppError::internal("preparing profile services", error))?;
    let rows = statement.query_map([profile_id], |row| Ok(ProfileServiceView { id: row.get(0)?, profile_id: row.get(1)?, service_id: row.get(2)?, cuda_device: row.get(3)?, start_on_boot: row.get::<_, i64>(4)? != 0, auto_restart: row.get::<_, i64>(5)? != 0, service: ProfileServiceSummary { name: row.get(6)?, port: row.get(7)? } }))
        .map_err(|error| AppError::internal("querying profile services", error))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| AppError::internal("decoding profile services", error))
}

/// Captures an effective configuration inside an existing transaction.
fn snapshot_in_transaction(connection: &Connection, service_id: &str, profile_id: Option<&str>) -> AppResult<Option<ConfigSnapshot>> {
    let service = connection.query_row(&format!("{SERVICE_SELECT_BASE} WHERE id=?1"), [service_id], map_service_row).optional()
        .map_err(|error| AppError::internal("capturing service snapshot", error))?;
    let Some(service) = service else { return Ok(None) };
    let profile = if let Some(profile_id) = profile_id {
        connection.query_row("SELECT id,name FROM RunProfile WHERE id=?1", [profile_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).optional()
    } else {
        connection.query_row("SELECT id,name FROM RunProfile WHERE isActive=1 LIMIT 1", [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).optional()
    }.map_err(|error| AppError::internal("capturing profile snapshot", error))?;
    let override_row = profile.as_ref().and_then(|(id, _)| connection.query_row("SELECT cudaDevice,startOnBoot,autoRestart FROM RunProfileService WHERE profileId=?1 AND serviceId=?2", params![id, service_id], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)? != 0, row.get::<_, i64>(2)? != 0))).optional().ok().flatten());
    Ok(Some(ConfigSnapshot { name: service.name, description: service.description, command: service.command, port: service.port, no_port: service.no_port, wsl: service.wsl, min_free_vram_mb: service.min_free_vram_mb, profile_id: profile.as_ref().map(|value| value.0.clone()), profile_name: profile.as_ref().map(|value| value.1.clone()), cuda_device: override_row.as_ref().and_then(|value| value.0.clone()), start_on_boot: override_row.as_ref().map(|value| value.1).unwrap_or(false), auto_restart: override_row.as_ref().map(|value| value.2).unwrap_or(false) }))
}

/// Inserts an immutable revision and precomputes its changed-field array.
#[allow(clippy::too_many_arguments)]
fn insert_revision(connection: &Connection, service_id: &str, service_name: &str, change_type: &str, author: &str, reason: &str, previous: Option<&ConfigSnapshot>, snapshot: Option<&ConfigSnapshot>, reverted_from: Option<&str>) -> AppResult<()> {
    let changed_fields = diff_snapshots(previous, snapshot);
    let profile_id = snapshot.and_then(|value| value.profile_id.clone()).or_else(|| previous.and_then(|value| value.profile_id.clone()));
    let profile_name = snapshot.and_then(|value| value.profile_name.clone()).or_else(|| previous.and_then(|value| value.profile_name.clone()));
    connection.execute("INSERT INTO ConfigRevision (id,serviceId,serviceName,profileId,profileName,changeType,author,reason,snapshot,previous,changedFields,revertedFromRevisionId,createdAt) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)", params![new_id(), service_id, service_name, profile_id, profile_name, change_type, author, reason, snapshot.map(serde_json::to_string).transpose().map_err(|error| AppError::internal("serializing revision snapshot", error))?, previous.map(serde_json::to_string).transpose().map_err(|error| AppError::internal("serializing previous snapshot", error))?, serde_json::to_string(&changed_fields).map_err(|error| AppError::internal("serializing changed fields", error))?, reverted_from, now_millis()])
        .map_err(|error| AppError::internal("recording configuration revision", error))?;
    Ok(())
}

/// Decodes one revision row and its JSON payloads.
fn map_revision_row(row: &Row<'_>) -> rusqlite::Result<ConfigRevisionView> {
    let snapshot: Option<String> = row.get(8)?;
    let previous: Option<String> = row.get(9)?;
    let changed: String = row.get(10)?;
    Ok(ConfigRevisionView { id: row.get(0)?, service_id: row.get(1)?, service_name: row.get(2)?, profile_id: row.get(3)?, profile_name: row.get(4)?, change_type: row.get(5)?, author: row.get(6)?, reason: row.get(7)?, snapshot: snapshot.and_then(|value| serde_json::from_str(&value).ok()), previous: previous.and_then(|value| serde_json::from_str(&value).ok()), changed_fields: serde_json::from_str(&changed).unwrap_or_default(), reverted_from_revision_id: row.get(11)?, created_at: decode_datetime(row, 12)? })
}

/// Returns a stable list of profile identifiers and names inside a transaction.
fn profile_ids(connection: &Connection) -> AppResult<Vec<(String, String)>> {
    let mut statement = connection.prepare("SELECT id,name FROM RunProfile ORDER BY createdAt ASC").map_err(|error| AppError::internal("preparing profile identifiers", error))?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|error| AppError::internal("querying profile identifiers", error))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| AppError::internal("decoding profile identifiers", error))
}

/// Applies active-profile fields from a service mutation without overwriting omitted values.
fn update_active_override(connection: &Connection, service_id: &str, mutation: &ServiceMutation) -> AppResult<()> {
    if mutation.cuda_device.is_none() && mutation.start_on_boot.is_none() && mutation.auto_restart.is_none() { return Ok(()); }
    let profile_id: String = connection.query_row("SELECT id FROM RunProfile WHERE isActive=1 LIMIT 1", [], |row| row.get(0)).optional().map_err(|error| AppError::internal("querying active profile", error))?.ok_or_else(|| AppError::Conflict("No active run profile".into()))?;
    let current = connection.query_row("SELECT id,cudaDevice,startOnBoot,autoRestart FROM RunProfileService WHERE profileId=?1 AND serviceId=?2", params![profile_id, service_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)? != 0, row.get::<_, i64>(3)? != 0))).optional().map_err(|error| AppError::internal("querying active service override", error))?;
    let (id, cuda, boot, restart) = current.unwrap_or_else(|| (new_id(), None, false, false));
    connection.execute("INSERT INTO RunProfileService (id,profileId,serviceId,cudaDevice,startOnBoot,autoRestart) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(profileId,serviceId) DO UPDATE SET cudaDevice=excluded.cudaDevice,startOnBoot=excluded.startOnBoot,autoRestart=excluded.autoRestart", params![id, profile_id, service_id, mutation.cuda_device.clone().unwrap_or(cuda), bool_i64(mutation.start_on_boot.unwrap_or(boot)), bool_i64(mutation.auto_restart.unwrap_or(restart))]).map_err(|error| AppError::internal("updating active service override", error))?;
    Ok(())
}

/// Merges omitted service fields with their current persistent values.
fn merge_service_mutation(current: &ServiceRow, mutation: &ServiceMutation) -> ServiceRow {
    ServiceRow { id: current.id.clone(), name: mutation.name.clone().unwrap_or_else(|| current.name.clone()), description: mutation.description.clone().unwrap_or_else(|| current.description.clone()), command: mutation.command.clone().unwrap_or_else(|| current.command.clone()), port: mutation.port.unwrap_or(current.port), no_port: mutation.no_port.unwrap_or(current.no_port), wsl: mutation.wsl.unwrap_or(current.wsl), cuda_device: current.cuda_device.clone(), min_free_vram_mb: mutation.min_free_vram_mb.unwrap_or(current.min_free_vram_mb), start_on_boot: current.start_on_boot, pid: current.pid, status: current.status.clone(), desired_status: current.desired_status.clone(), created_at: current.created_at.clone(), updated_at: format_datetime(now_millis()) }
}

/// Computes JSON field-level differences between two effective snapshots.
fn diff_snapshots(previous: Option<&ConfigSnapshot>, snapshot: Option<&ConfigSnapshot>) -> Vec<Value> {
    let before = previous.and_then(|value| serde_json::to_value(value).ok()).unwrap_or(Value::Null);
    let after = snapshot.and_then(|value| serde_json::to_value(value).ok()).unwrap_or(Value::Null);
    let mut keys = std::collections::BTreeSet::new();
    if let Value::Object(object) = &before { keys.extend(object.keys().cloned()); }
    if let Value::Object(object) = &after { keys.extend(object.keys().cloned()); }
    keys.into_iter().filter_map(|field| { let from = before.get(&field).cloned().unwrap_or(Value::Null); let to = after.get(&field).cloned().unwrap_or(Value::Null); (from != to).then(|| json!({"field":field,"from":from,"to":to})) }).collect()
}

/// Converts optional nested numeric input into its database value.
fn flatten_option<T: Copy>(value: &Option<Option<T>>) -> Option<T> { value.as_ref().copied().flatten() }

/// Converts optional nested string input into its database value.
fn flatten_string(value: &Option<Option<String>>) -> Option<String> { value.as_ref().cloned().flatten() }

/// Validates a required non-empty text field.
fn required_text<'a>(value: Option<&'a str>, message: &str) -> AppResult<&'a str> {
    value.filter(|text| !text.trim().is_empty()).map(str::trim).ok_or_else(|| AppError::BadRequest(message.into()))
}

/// Returns SQLite's integer representation for a boolean.
fn bool_i64(value: bool) -> i64 { if value { 1 } else { 0 } }

/// Produces a collision-resistant local identifier without changing existing IDs.
fn new_id() -> String { Uuid::new_v4().simple().to_string() }

/// Decodes Prisma's SQLite epoch-millisecond DateTime into its JSON representation.
fn decode_datetime(row: &Row<'_>, index: usize) -> rusqlite::Result<String> {
    let value: i64 = row.get(index)?;
    DateTime::<Utc>::from_timestamp_millis(value).map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true)).ok_or_else(|| rusqlite::Error::FromSqlConversionFailure(index, Type::Integer, Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, format!("invalid epoch-millisecond timestamp: {value}")))))
}

/// Formats a known-valid epoch-millisecond timestamp for API JSON.
fn format_datetime(value: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(value).expect("current UTC timestamp must be representable").to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Produces Prisma's SQLite INTEGER representation for a UTC DateTime.
fn now_millis() -> i64 { Utc::now().timestamp_millis() }

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a complete in-memory replica of the current Prisma schema for repository tests.
    fn test_database() -> Database {
        let connection = Connection::open_in_memory().expect("opening in-memory database");
        connection.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE Service (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT,command TEXT NOT NULL,port INTEGER,noPort INTEGER NOT NULL DEFAULT 0,wsl INTEGER NOT NULL DEFAULT 0,cudaDevice TEXT,minFreeVramMb INTEGER,startOnBoot INTEGER NOT NULL DEFAULT 0,pid INTEGER,status TEXT NOT NULL DEFAULT 'stopped',desiredStatus TEXT NOT NULL DEFAULT 'stopped',createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
             CREATE TABLE RunProfile (id TEXT PRIMARY KEY,name TEXT NOT NULL,isActive INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
             CREATE TABLE RunProfileService (id TEXT PRIMARY KEY,profileId TEXT NOT NULL,serviceId TEXT NOT NULL,cudaDevice TEXT,startOnBoot INTEGER NOT NULL DEFAULT 0,autoRestart INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(profileId) REFERENCES RunProfile(id) ON DELETE CASCADE,FOREIGN KEY(serviceId) REFERENCES Service(id) ON DELETE CASCADE,UNIQUE(profileId,serviceId));
             CREATE TABLE ConfigRevision (id TEXT PRIMARY KEY,serviceId TEXT NOT NULL,serviceName TEXT NOT NULL,profileId TEXT,profileName TEXT,changeType TEXT NOT NULL,author TEXT NOT NULL DEFAULT 'ui',reason TEXT NOT NULL,snapshot TEXT,previous TEXT,changedFields TEXT NOT NULL DEFAULT '[]',revertedFromRevisionId TEXT,createdAt INTEGER NOT NULL);
             INSERT INTO RunProfile (id,name,isActive,createdAt,updatedAt) VALUES ('balanced','Balanced',1,1770305420144,1770305420144),('two-gpu','2 Gpu',0,1770305420145,1770305420145);",
        ).expect("creating test schema");
        Database { connection: Mutex::new(connection) }
    }

    /// Creates a representative service mutation for repository operations.
    fn test_mutation() -> ServiceMutation {
        ServiceMutation { name: Some("Fixture Service".into()), description: Some(Some("fixture description".into())), command: Some("node fixture.cjs".into()), port: Some(Some(45678)), no_port: Some(false), wsl: Some(false), cuda_device: Some(Some("1".into())), min_free_vram_mb: Some(Some(2048)), start_on_boot: Some(true), auto_restart: Some(true), reason: None, author: None }
    }

    /// Confirms field diffs include only values that actually changed.
    #[test]
    fn snapshot_diff_reports_changed_values() {
        let before = ConfigSnapshot { name: "A".into(), description: None, command: "one".into(), port: Some(1), no_port: false, wsl: false, min_free_vram_mb: None, profile_id: None, profile_name: None, cuda_device: None, start_on_boot: false, auto_restart: false };
        let after = ConfigSnapshot { name: "A".into(), command: "two".into(), ..before.clone() };
        let diff = diff_snapshots(Some(&before), Some(&after));
        assert_eq!(diff.len(), 1);
        assert_eq!(diff[0]["field"], "command");
    }

    /// Integer Prisma timestamps decode to the same millisecond ISO strings emitted by Node.
    #[test]
    fn prisma_integer_timestamps_decode_to_json_dates() {
        let database = test_database();
        let profile = database.active_profile().expect("loading active profile").expect("active profile");
        assert_eq!(profile.created_at, "2026-02-05T15:30:20.144Z");
    }

    /// Service creation writes integer timestamps, all profile overrides, and one immutable revision.
    #[test]
    fn create_service_preserves_prisma_storage_contract() {
        let database = test_database();
        let service = database.create_service(&test_mutation(), "Create integration fixture", "agent").expect("creating fixture service");
        let connection = database.connection.lock();
        let storage_types: (String, String) = connection.query_row("SELECT typeof(createdAt),typeof(updatedAt) FROM Service WHERE id=?1", [&service.id], |row| Ok((row.get(0)?, row.get(1)?))).expect("reading timestamp types");
        let override_count: i64 = connection.query_row("SELECT count(*) FROM RunProfileService WHERE serviceId=?1", [&service.id], |row| row.get(0)).expect("counting overrides");
        let revision_type: String = connection.query_row("SELECT typeof(createdAt) FROM ConfigRevision WHERE serviceId=?1", [&service.id], |row| row.get(0)).expect("reading revision timestamp type");
        assert_eq!(storage_types, ("integer".into(), "integer".into()));
        assert_eq!(revision_type, "integer");
        assert_eq!(override_count, 2);
    }

    /// Omitted optional fields remain unchanged while explicit null clears a nullable field.
    #[test]
    fn update_service_distinguishes_omitted_and_null_fields() {
        let database = test_database();
        let service = database.create_service(&test_mutation(), "Create integration fixture", "agent").expect("creating fixture service");
        let rename = ServiceMutation { name: Some("Renamed Fixture".into()), ..ServiceMutation::default() };
        let renamed = database.update_service(&service.id, &rename, "Rename integration fixture", "agent", "update", None).expect("renaming fixture");
        assert_eq!(renamed.description.as_deref(), Some("fixture description"));
        let clear = ServiceMutation { description: Some(None), ..ServiceMutation::default() };
        let cleared = database.update_service(&service.id, &clear, "Clear fixture description", "agent", "update", None).expect("clearing description");
        assert_eq!(cleared.description, None);
    }

    /// Profile creation clones every active override and stores Prisma-compatible integer dates.
    #[test]
    fn profile_creation_clones_active_overrides() {
        let database = test_database();
        database.create_service(&test_mutation(), "Create integration fixture", "agent").expect("creating fixture service");
        let profile = database.create_profile("Cloned Profile").expect("creating cloned profile");
        let connection = database.connection.lock();
        let timestamp_type: String = connection.query_row("SELECT typeof(createdAt) FROM RunProfile WHERE id=?1", [&profile.id], |row| row.get(0)).expect("reading profile timestamp type");
        assert_eq!(timestamp_type, "integer");
        assert_eq!(profile.services.len(), 1);
        assert!(profile.services[0].start_on_boot);
        assert!(profile.services[0].auto_restart);
    }

    /// Profile override changes persist effective configuration and append a revision.
    #[test]
    fn profile_override_records_revision() {
        let database = test_database();
        let service = database.create_service(&test_mutation(), "Create integration fixture", "agent").expect("creating fixture service");
        let result = database.update_profile_override("balanced", &service.id, Some(Some("0".into())), Some(false), Some(false), "Move fixture to GPU zero", "agent").expect("updating profile override");
        let revisions = database.list_revisions(&service.id, 10).expect("listing revisions");
        assert_eq!(result.cuda_device.as_deref(), Some("0"));
        assert_eq!(revisions.len(), 2);
        assert!(revisions.iter().any(|revision| revision.change_type == "update"));
    }

    /// Runtime and desired-state updates keep every DateTime column as an INTEGER.
    #[test]
    fn runtime_updates_keep_integer_timestamps() {
        let database = test_database();
        let service = database.create_service(&test_mutation(), "Create integration fixture", "agent").expect("creating fixture service");
        database.update_runtime(&service.id, "running", Some(1234)).expect("updating runtime");
        database.set_desired_status(&service.id, "running").expect("updating desired state");
        let connection = database.connection.lock();
        let values: (String, String, i64) = connection.query_row("SELECT status,desiredStatus,typeof(updatedAt)='integer' FROM Service WHERE id=?1", [&service.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).expect("reading runtime values");
        assert_eq!(values, ("running".into(), "running".into(), 1));
    }

    /// Historical revision JSON remains byte-semantically compatible even when newer fields are absent.
    #[test]
    fn historical_revision_payloads_remain_unmodified() {
        let database = test_database();
        let connection = database.connection.lock();
        connection.execute("INSERT INTO ConfigRevision (id,serviceId,serviceName,changeType,author,reason,snapshot,changedFields,createdAt) VALUES ('old','svc','Old Service','baseline','api','Historical baseline','{\"name\":\"Old Service\",\"description\":null,\"command\":\"old.cmd\",\"port\":null,\"noPort\":true,\"wsl\":false,\"minFreeVramMb\":null,\"profileId\":null,\"profileName\":null,\"cudaDevice\":null,\"startOnBoot\":false}','[]',1770305420144)", []).expect("inserting historical revision");
        drop(connection);
        let revision = database.get_revision("svc", "old").expect("reading historical revision").expect("historical revision");
        assert_eq!(revision.snapshot.expect("snapshot").get("autoRestart"), None);
    }
}
