//! Storage system
//!
//! Data persistence, cleanup, and storage policies.

pub mod cleanup;
pub mod persistence;
pub mod vault;
pub use cleanup::{CleanupPolicy, CleanupResult, CleanupService};

pub use persistence::{PersistenceService, StorageOptions};
pub use vault::EncryptedVault;
