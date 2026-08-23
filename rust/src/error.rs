use axum::{Json, http::StatusCode, response::{IntoResponse, Response}};
use serde_json::{Value, json};
use thiserror::Error;

/// Typed application failure that preserves the existing API status and JSON error shape.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    MethodNotAllowed(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    /// Wraps a database or operating-system failure with safe caller-facing context.
    pub fn internal(context: impl Into<String>, error: impl std::fmt::Display) -> Self {
        let context = context.into();
        tracing::error!(%context, %error, "Service Manager operation failed");
        Self::Internal(anyhow::anyhow!(context))
    }

    /// Produces the legacy kill-port response body whose error key is `message`.
    pub fn message_response(self) -> Response {
        let status = self.status();
        (status, Json(json!({ "message": self.to_string() }))).into_response()
    }

    /// Returns the HTTP status associated with this typed failure.
    pub fn status(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::MethodNotAllowed(_) => StatusCode::METHOD_NOT_ALLOWED,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    /// Serializes failures using the existing `{ error }` contract.
    fn into_response(self) -> Response {
        let status = self.status();
        let body: Value = json!({ "error": self.to_string() });
        (status, Json(body)).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;

