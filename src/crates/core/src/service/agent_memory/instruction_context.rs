use crate::util::errors::*;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use tokio::fs;

const WORKSPACE_INSTRUCTION_FILE_NAMES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];
const MAX_INSTRUCTION_FILE_CHARS: usize = 4_000;
const MAX_TOTAL_INSTRUCTION_CHARS: usize = 12_000;

#[derive(Debug)]
struct WorkspaceInstructionFile {
    name: String,
    content: String,
}

async fn load_workspace_instruction_files(
    workspace_root: &Path,
) -> Ai00XResult<Vec<WorkspaceInstructionFile>> {
    let mut files = Vec::new();

    for file_name in WORKSPACE_INSTRUCTION_FILE_NAMES {
        let path = workspace_root.join(file_name);
        if !path.exists() || !path.is_file() {
            continue;
        }

        let content = fs::read_to_string(&path).await.map_err(|e| {
            Ai00XError::service(format!(
                "Failed to read workspace instruction file {}: {}",
                path.display(),
                e
            ))
        })?;

        if content.trim().is_empty() {
            continue;
        }

        files.push(WorkspaceInstructionFile {
            name: file_name.to_string(),
            content,
        });
    }

    Ok(files)
}

fn dedupe_instruction_files(files: Vec<WorkspaceInstructionFile>) -> Vec<WorkspaceInstructionFile> {
    let mut deduped = Vec::new();
    let mut seen_hashes = Vec::new();

    for file in files {
        let normalized = collapse_blank_lines(&file.content).trim().to_string();
        let mut hasher = DefaultHasher::new();
        normalized.hash(&mut hasher);
        let hash = hasher.finish();

        if seen_hashes.contains(&hash) {
            continue;
        }
        seen_hashes.push(hash);
        deduped.push(file);
    }

    deduped
}

fn collapse_blank_lines(content: &str) -> String {
    let mut result = String::new();
    let mut previous_blank = false;
    for line in content.lines() {
        let is_blank = line.trim().is_empty();
        if is_blank && previous_blank {
            continue;
        }
        result.push_str(line.trim_end());
        result.push('\n');
        previous_blank = is_blank;
    }
    result
}

fn truncate_instruction_content(content: &str, remaining_chars: usize) -> String {
    let hard_limit = MAX_INSTRUCTION_FILE_CHARS.min(remaining_chars);
    let trimmed = content.trim();
    if trimmed.chars().count() <= hard_limit {
        return trimmed.to_string();
    }

    let mut output: String = trimmed.chars().take(hard_limit).collect();
    output.push_str("\n\n[truncated]");
    output
}

fn render_workspace_instruction_files_section(
    files: &[WorkspaceInstructionFile],
) -> Option<String> {
    if files.is_empty() {
        return None;
    }

    let mut rendered =
        String::from("As you answer the user's questions, you can use the following context:\n\n");

    let mut remaining_chars = MAX_TOTAL_INSTRUCTION_CHARS;

    for file in files {
        if remaining_chars == 0 {
            rendered.push_str(
                "_Additional instruction content omitted after reaching the prompt budget._\n\n",
            );
            break;
        }

        let raw_content = truncate_instruction_content(&file.content, remaining_chars);
        let consumed = raw_content.chars().count().min(remaining_chars);
        remaining_chars = remaining_chars.saturating_sub(consumed);

        rendered.push_str(&format!(
            "<document name=\"{}\">\n{}\n</document>\n\n",
            file.name, raw_content
        ));
    }

    Some(rendered.trim_end().to_string())
}

pub(crate) async fn build_workspace_instruction_files_context(
    workspace_root: &Path,
) -> Ai00XResult<Option<String>> {
    let instruction_files = load_workspace_instruction_files(workspace_root).await?;
    let deduped = dedupe_instruction_files(instruction_files);
    Ok(render_workspace_instruction_files_section(&deduped))
}
