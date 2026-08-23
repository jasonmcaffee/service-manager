use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// Persistent service row matching the existing Prisma SQLite schema.
#[derive(Clone, Debug)]
pub struct ServiceRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub command: String,
    pub port: Option<i64>,
    pub no_port: bool,
    pub wsl: bool,
    pub cuda_device: Option<String>,
    pub min_free_vram_mb: Option<i64>,
    pub start_on_boot: bool,
    pub pid: Option<i64>,
    pub status: String,
    pub desired_status: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Hydrated service response consumed by the existing React UI and API clients.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceView {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub command: String,
    pub port: Option<i64>,
    pub no_port: bool,
    pub wsl: bool,
    pub cuda_device: Option<String>,
    pub registered_cuda_device: Option<String>,
    pub cuda_device_source: String,
    pub cuda_device_conflict: Option<String>,
    pub min_free_vram_mb: Option<i64>,
    pub start_on_boot: bool,
    pub auto_restart: bool,
    pub pid: Option<i64>,
    pub status: String,
    pub desired_status: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Vec<String>>,
}

/// Profile row and its hydrated service overrides.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub id: String,
    pub name: String,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
    pub services: Vec<ProfileServiceView>,
}

/// Per-profile service configuration with the nested service summary Prisma returned.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileServiceView {
    pub id: String,
    pub profile_id: String,
    pub service_id: String,
    pub cuda_device: Option<String>,
    pub start_on_boot: bool,
    pub auto_restart: bool,
    pub service: ProfileServiceSummary,
}

/// Minimal service record nested inside a profile response.
#[derive(Clone, Debug, Serialize)]
pub struct ProfileServiceSummary {
    pub name: String,
    pub port: Option<i64>,
}

/// Effective configuration captured in immutable revision history.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub name: String,
    pub description: Option<String>,
    pub command: String,
    pub port: Option<i64>,
    pub no_port: bool,
    pub wsl: bool,
    pub min_free_vram_mb: Option<i64>,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub cuda_device: Option<String>,
    pub start_on_boot: bool,
    #[serde(default)]
    pub auto_restart: bool,
}

/// One decoded immutable configuration revision.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigRevisionView {
    pub id: String,
    pub service_id: String,
    pub service_name: String,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub change_type: String,
    pub author: String,
    pub reason: String,
    pub snapshot: Option<Value>,
    pub previous: Option<Value>,
    pub changed_fields: Vec<Value>,
    pub reverted_from_revision_id: Option<String>,
    pub created_at: String,
}

/// Service fields accepted by create and partial update endpoints.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceMutation {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_field")]
    pub description: Option<Option<String>>,
    pub command: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_field")]
    pub port: Option<Option<i64>>,
    pub no_port: Option<bool>,
    pub wsl: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_nullable_field")]
    pub cuda_device: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_nullable_field")]
    pub min_free_vram_mb: Option<Option<i64>>,
    pub start_on_boot: Option<bool>,
    pub auto_restart: Option<bool>,
    pub reason: Option<String>,
    pub author: Option<String>,
}

/// Profile override fields accepted by its PUT endpoint.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileOverrideMutation {
    #[serde(default, deserialize_with = "deserialize_nullable_field")]
    pub cuda_device: Option<Option<String>>,
    pub start_on_boot: Option<bool>,
    pub auto_restart: Option<bool>,
    pub reason: Option<String>,
    pub author: Option<String>,
}

/// Distinguishes an omitted JSON field from an explicit null for partial mutations.
fn deserialize_nullable_field<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error> where D: Deserializer<'de>, T: Deserialize<'de> {
    Option::<T>::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Explicit null clears nullable fields while omission preserves the current value.
    #[test]
    fn nullable_mutations_distinguish_null_from_omission() {
        let omitted: ServiceMutation = serde_json::from_str("{}").expect("decoding omitted fields");
        let cleared: ServiceMutation = serde_json::from_str(r#"{"description":null,"port":null,"cudaDevice":null,"minFreeVramMb":null}"#).expect("decoding null fields");
        assert_eq!(omitted.description, None);
        assert_eq!(cleared.description, Some(None));
        assert_eq!(cleared.port, Some(None));
        assert_eq!(cleared.cuda_device, Some(None));
        assert_eq!(cleared.min_free_vram_mb, Some(None));
    }
}
