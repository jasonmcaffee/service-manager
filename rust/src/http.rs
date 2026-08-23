use crate::error::{AppError, AppResult};
use crate::logging::clear_run_log;
use crate::models::{ProfileOverrideMutation, ServiceMutation};
use crate::service::AppState;
use crate::system::snapshot_listeners;
use axum::{Json, Router, body::Body, extract::{Path, Query, Request, State}, http::{HeaderMap, HeaderValue, StatusCode, header}, middleware::{self, Next}, response::{IntoResponse, Response}, routing::{any, get, patch, post, put}};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use tower_http::{compression::CompressionLayer, limit::RequestBodyLimitLayer, services::ServeDir, trace::TraceLayer};

/// Builds the production router, compatibility API, operational endpoints, and static UI service.
pub fn build_application(state: AppState) -> Router {
    let static_root = state.config.repository_root.join(".next").join("static");
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(readiness))
        .route("/version", get(version))
        .route("/metrics", get(metrics))
        .route("/api/services", get(list_services).post(create_service))
        .route("/api/services/startup", post(startup_services))
        .route("/api/services/{id}", get(get_service).put(update_service).delete(delete_service))
        .route("/api/services/{id}/control", post(control_service))
        .route("/api/services/{id}/output", get(service_output).delete(clear_output))
        .route("/api/services/{id}/revisions", get(list_revisions))
        .route("/api/services/{id}/revisions/{revision_id}/revert", post(revert_revision))
        .route("/api/profiles", get(list_profiles).post(create_profile))
        .route("/api/profiles/active", get(active_profile).put(switch_profile))
        .route("/api/profiles/{id}", patch(rename_profile).delete(delete_profile))
        .route("/api/profiles/{id}/services/{service_id}", put(update_profile_override))
        .route("/api/kill-port", post(kill_port))
        .nest_service("/_next/static", ServeDir::new(static_root))
        .fallback(any(static_fallback))
        .layer(RequestBodyLimitLayer::new(1024 * 1024))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn_with_state(state.clone(), record_request))
        .with_state(state)
}

/// Records low-cardinality request and error counts around the complete router.
async fn record_request(State(state): State<AppState>, request: Request, next: Next) -> Response {
    state.metrics.note_request();
    let immutable_asset = request.uri().path().starts_with("/_next/static/");
    let mut response = next.run(request).await;
    if immutable_asset { response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable")); }
    if response.status().is_client_error() || response.status().is_server_error() { state.metrics.note_error(); }
    response
}

/// Returns native process liveness without depending on database readiness.
async fn health() -> Json<Value> { Json(json!({"status":"ok","runtime":"rust"})) }

/// Returns readiness only after database open, adoption, and boot initialization.
async fn readiness(State(state): State<AppState>) -> Response {
    if state.metrics.is_ready() { (StatusCode::OK, Json(json!({"status":"ready"}))).into_response() } else { (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"status":"starting"}))).into_response() }
}

/// Returns build identity for production and rollback diagnostics.
async fn version() -> Json<Value> { Json(json!({"name":"service-manager-rs","version":env!("CARGO_PKG_VERSION"),"runtime":"rust"})) }

/// Returns Prometheus-compatible native metrics.
async fn metrics(State(state): State<AppState>) -> AppResult<Response> {
    Ok(([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], state.rendered_metrics()?).into_response())
}

/// Lists hydrated services in stable creation order.
async fn list_services(State(state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(serde_json::to_value(state.list_service_views()?).map_err(|error| AppError::internal("serializing services", error))?))
}

/// Creates one reasoned service configuration.
async fn create_service(State(state): State<AppState>, headers: HeaderMap, Query(query): Query<HashMap<String, String>>, Json(body): Json<ServiceMutation>) -> AppResult<Response> {
    let (reason, author) = change_context(&headers, &query, body.reason.as_deref(), body.author.as_deref());
    let service = state.create_service(&body, &reason, &author)?;
    Ok((StatusCode::CREATED, Json(service)).into_response())
}

/// Returns one hydrated service or the legacy 404 body.
async fn get_service(State(state): State<AppState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let service = state.get_service_view(&id)?.ok_or_else(|| AppError::NotFound("Service not found".into()))?;
    Ok(Json(serde_json::to_value(service).map_err(|error| AppError::internal("serializing service", error))?))
}

/// Applies a reasoned partial service update.
async fn update_service(State(state): State<AppState>, Path(id): Path<String>, headers: HeaderMap, Query(query): Query<HashMap<String, String>>, Json(body): Json<ServiceMutation>) -> AppResult<Json<Value>> {
    let (reason, author) = change_context(&headers, &query, body.reason.as_deref(), body.author.as_deref());
    let service = state.update_service(&id, &body, &reason, &author)?;
    Ok(Json(serde_json::to_value(service).map_err(|error| AppError::internal("serializing updated service", error))?))
}

/// Deletes one service after requiring an auditable reason.
async fn delete_service(State(state): State<AppState>, Path(id): Path<String>, headers: HeaderMap, Query(query): Query<HashMap<String, String>>, body: Option<Json<ServiceMutation>>) -> AppResult<Json<Value>> {
    let body = body.map(|Json(value)| value).unwrap_or_default();
    let (reason, author) = change_context(&headers, &query, body.reason.as_deref(), body.author.as_deref());
    state.delete_service(&id, &reason, &author).await?;
    Ok(Json(json!({"success":true})))
}

#[derive(Deserialize)]
struct ControlBody { action: String }

/// Dispatches one lifecycle action through the guarded domain service.
async fn control_service(State(state): State<AppState>, Path(id): Path<String>, Json(body): Json<ControlBody>) -> AppResult<Json<Value>> {
    let result = match body.action.as_str() { "start" => state.start_service(&id).await?, "stop" => state.stop_service(&id).await?, "restart" => state.restart_service(&id).await?, _ => return Err(AppError::BadRequest("Invalid action".into())) };
    Ok(Json(result))
}

/// Returns bounded run logs, durable events, status, and PID.
async fn service_output(State(state): State<AppState>, Path(id): Path<String>) -> AppResult<Json<Value>> { Ok(Json(state.service_output(&id)?)) }

/// Clears one run log without touching durable Service Manager events.
async fn clear_output(State(state): State<AppState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    clear_run_log(&state.config.runtime_root, &id)?;
    Ok(Json(json!({"success":true})))
}

/// Triggers the idempotent boot-start pass.
async fn startup_services(State(state): State<AppState>) -> AppResult<Json<Value>> { Ok(Json(state.run_auto_start().await?)) }

/// Lists decoded revisions newest first with a bounded query limit.
async fn list_revisions(State(state): State<AppState>, Path(id): Path<String>, Query(query): Query<HashMap<String, String>>) -> AppResult<Json<Value>> {
    let limit = query.get("limit").and_then(|value| value.parse::<usize>().ok()).unwrap_or(50).clamp(1, 500);
    Ok(Json(json!({"revisions":state.database.list_revisions(&id, limit)?})))
}

/// Restores a prior configuration as a normal reasoned forward revision.
async fn revert_revision(State(state): State<AppState>, Path((id, revision_id)): Path<(String, String)>, headers: HeaderMap, Query(query): Query<HashMap<String, String>>, body: Option<Json<ServiceMutation>>) -> AppResult<Json<Value>> {
    let body = body.map(|Json(value)| value).unwrap_or_default();
    let (reason, author) = change_context(&headers, &query, body.reason.as_deref(), body.author.as_deref());
    Ok(Json(state.revert_service(&id, &revision_id, &reason, &author)?))
}

/// Lists every hydrated run profile.
async fn list_profiles(State(state): State<AppState>) -> AppResult<Json<Value>> { Ok(Json(serde_json::to_value(state.database.list_profiles()?).map_err(|error| AppError::internal("serializing profiles", error))?)) }

#[derive(Deserialize)]
struct NameBody { name: String }

/// Creates a profile cloned from the active profile.
async fn create_profile(State(state): State<AppState>, Json(body): Json<NameBody>) -> AppResult<Response> {
    let name = body.name.trim();
    if name.is_empty() { return Err(AppError::BadRequest("Name is required".into())); }
    Ok((StatusCode::CREATED, Json(state.database.create_profile(name)?)).into_response())
}

/// Returns the active profile or the legacy 404 response.
async fn active_profile(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let profile = state.database.active_profile()?.ok_or_else(|| AppError::NotFound("No active profile".into()))?;
    Ok(Json(serde_json::to_value(profile).map_err(|error| AppError::internal("serializing active profile", error))?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwitchProfileBody { profile_id: String }

/// Switches profiles with stop-before-start lifecycle ordering.
async fn switch_profile(State(state): State<AppState>, Json(body): Json<SwitchProfileBody>) -> AppResult<Json<Value>> { Ok(Json(state.switch_profile(&body.profile_id).await?)) }

/// Renames one profile after validating non-empty text.
async fn rename_profile(State(state): State<AppState>, Path(id): Path<String>, Json(body): Json<NameBody>) -> AppResult<Json<Value>> {
    let name = body.name.trim();
    if name.is_empty() { return Err(AppError::BadRequest("Name is required".into())); }
    Ok(Json(serde_json::to_value(state.database.rename_profile(&id, name)?).map_err(|error| AppError::internal("serializing renamed profile", error))?))
}

/// Deletes one non-active, non-last profile.
async fn delete_profile(State(state): State<AppState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    state.database.delete_profile(&id)?;
    Ok(Json(json!({"id":id,"deleted":true})))
}

/// Updates one reasoned per-profile service override.
async fn update_profile_override(State(state): State<AppState>, Path((id, service_id)): Path<(String, String)>, headers: HeaderMap, Query(query): Query<HashMap<String, String>>, Json(body): Json<ProfileOverrideMutation>) -> AppResult<Json<Value>> {
    let (reason, author) = change_context(&headers, &query, body.reason.as_deref(), body.author.as_deref());
    Ok(Json(state.update_profile_override(&id, &service_id, &body, &reason, &author)?))
}

#[derive(Deserialize)]
struct KillPortBody { port: i64 }

/// Kills exact registered-port listeners and preserves the legacy `{message}` response key.
async fn kill_port(State(state): State<AppState>, Json(body): Json<KillPortBody>) -> Response {
    match kill_port_result(&state, body.port).await { Ok(value) => Json(value).into_response(), Err(error) => error.message_response() }
}

/// Performs validated exact-port termination for the kill-port route.
async fn kill_port_result(state: &AppState, port: i64) -> AppResult<Value> {
    if !(1..=65535).contains(&port) { return Err(AppError::BadRequest("Invalid port number".into())); }
    let snapshot = snapshot_listeners().await;
    let listening = snapshot.windows.as_ref().is_some_and(|map| map.contains_key(&(port as u16))) || snapshot.wsl.as_ref().is_some_and(|map| map.contains_key(&(port as u16)));
    if !listening { return Err(AppError::NotFound(format!("No process found on port {port}"))); }
    let owner_id = state.database.services_by_port(port)?.first().map(|value| value.0.clone()).ok_or_else(|| AppError::Conflict(format!("Port {port} is not owned by a registered service.")))?;
    let service = state.database.get_service(&owner_id)?.ok_or_else(|| AppError::NotFound("Service not found".into()))?;
    let pids = state.processes.free_port(&service).await?;
    if pids.is_empty() { return Err(AppError::NotFound(format!("No process found on port {port}"))); }
    Ok(json!({"message":format!("Killed PID{}: {}", if pids.len()>1 {"s"} else {""}, pids.iter().map(u32::to_string).collect::<Vec<_>>().join(", ")),"pids":pids,"wsl":service.wsl}))
}

/// Serves the existing pre-rendered Next.js UI and rejects unknown API paths as JSON 404s.
async fn static_fallback(State(state): State<AppState>, request: Request<Body>) -> Response {
    if request.uri().path().starts_with("/api/") { return (StatusCode::NOT_FOUND, Json(json!({"error":"Not found"}))).into_response(); }
    let index = state.config.repository_root.join(".next").join("server").join("app").join("index.html");
    match tokio::fs::read(index).await { Ok(bytes) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], bytes).into_response(), Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "Service Manager UI build is missing; run npm run build").into_response() }
}

/// Extracts reason and author from JSON, headers, or query string with stable precedence.
fn change_context(headers: &HeaderMap, query: &HashMap<String, String>, body_reason: Option<&str>, body_author: Option<&str>) -> (String, String) {
    let reason = body_reason.map(str::to_owned).or_else(|| headers.get("x-change-reason").and_then(|value| value.to_str().ok()).map(str::to_owned)).or_else(|| query.get("reason").cloned()).unwrap_or_default();
    let requested_author = body_author.or_else(|| headers.get("x-change-author").and_then(|value| value.to_str().ok())).unwrap_or("ui").to_ascii_lowercase();
    let author = if matches!(requested_author.as_str(), "ui" | "agent" | "api") { requested_author } else { "api".into() };
    (reason, author)
}
