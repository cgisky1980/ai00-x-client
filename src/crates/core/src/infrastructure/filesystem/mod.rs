//! Filesystem infrastructure
//!
//! File operations and file tree building.

pub mod file_operations;
pub mod file_tree;
pub mod file_write_lock;

pub use file_operations::{
    normalize_text_for_editor_disk_sync, FileInfo, FileOperationOptions, FileOperationService,
    FileReadResult, FileWriteResult,
};
pub use file_tree::{
    BatchedFileSearchProgressSink, FileContentSearchOptions, FileNameSearchOptions,
    FileSearchOutcome, FileSearchProgressSink, FileSearchResult, FileSearchResultGroup,
    FileTreeNode, FileTreeOptions, FileTreeService, FileTreeStatistics, SearchMatchType,
};
pub use file_write_lock::{acquire_file_write_lock, atomic_write};
