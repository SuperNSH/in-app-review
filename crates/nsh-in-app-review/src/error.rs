//! The errors a review call reports. Each has a stable code; a message says what to do.

use std::fmt;

/// What went wrong, as a stable code; see [`InAppReviewError::code`].
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorKind {
    /// The platform has no review flow here (Windows, Linux, the web), or `is_available` answered false.
    NotAvailable,
    /// A review flow was interrupted before it completed.
    Cancelled,
    /// Another review flow is already running. One flow runs at a time.
    InProgress,
    /// The platform's review flow or URL opener failed; `status` holds its own code where it gives one.
    Backend,
    /// The store id this platform requires is missing or blank.
    InvalidArgument,
}

/// A failed review call, availability query or store listing.
///
/// `Display` names the message. Neither field holds user data.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}", .kind.message())]
pub struct InAppReviewError {
    kind: ErrorKind,
    status: Option<i64>,
}

impl InAppReviewError {
    /// An error of `kind`, with no platform status.
    pub fn new(kind: ErrorKind) -> Self {
        Self { kind, status: None }
    }

    /// The same error, carrying the platform's own status code.
    #[must_use]
    pub fn with_status(mut self, status: i64) -> Self {
        self.status = Some(status);
        self
    }

    /// What went wrong.
    pub fn kind(&self) -> ErrorKind {
        self.kind
    }

    /// The platform's status code, when the platform gave one.
    pub fn status(&self) -> Option<i64> {
        self.status
    }

    /// The stable code, such as `ERR_IN_APP_REVIEW_CANCELLED`. Apps match on this.
    pub fn code(&self) -> &'static str {
        self.kind.code()
    }
}

impl ErrorKind {
    /// The stable code of this kind.
    pub fn code(self) -> &'static str {
        match self {
            ErrorKind::NotAvailable => "ERR_IN_APP_REVIEW_NOT_AVAILABLE",
            ErrorKind::Cancelled => "ERR_IN_APP_REVIEW_CANCELLED",
            ErrorKind::InProgress => "ERR_IN_APP_REVIEW_IN_PROGRESS",
            ErrorKind::Backend => "ERR_IN_APP_REVIEW_BACKEND",
            ErrorKind::InvalidArgument => "ERR_IN_APP_REVIEW_INVALID_ARGUMENT",
        }
    }

    /// What to do about it, in one sentence.
    pub fn message(self) -> &'static str {
        match self {
            ErrorKind::NotAvailable => {
                "The platform has no in-app review flow here. Open the store listing instead."
            }
            ErrorKind::Cancelled => "The review flow was interrupted before it completed.",
            ErrorKind::InProgress => {
                "Another review flow is already running. Wait for it to finish."
            }
            ErrorKind::Backend => "The platform's review service or URL opener failed.",
            ErrorKind::InvalidArgument => {
                "The store id this platform requires is missing or empty."
            }
        }
    }
}

impl fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
