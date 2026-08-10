//! Hardcoded multi-version password table embedded at compile time.
//!
//! Each time a new client version is released, a new password entry can be
//! appended here and `CURRENT_PASSWORD_VERSION` incremented. Files packaged
//! with an older client version remain decryptable using the old password;
//! new files use the latest password.
//!
//! ## Security note
//!
//! These passwords are compiled into the binary and can theoretically be
//! extracted by reverse-engineering. This design explicitly accepts this
//! trade-off (user directive: "减少破解难度即可" — reducing crack difficulty
//! is acceptable). Mitigations:
//!
//! 1. **Version rotation**: after a password leak, ship a new client version
//!    with a new password. New files use the new password; the leaked
//!    password only compromises files packaged with that version.
//! 2. **Code obfuscation**: enable obfuscation in release builds.
//! 3. **Legal deterrence**: copyright metadata (`author_member_id` +
//!    `share_id` + `created_at`) embedded in every container provides an
//!    audit trail.
//!
//! ## Adding a new password version
//!
//! 1. Append a new `(version, password)` tuple to [`PASSWORDS`].
//! 2. Bump [`CURRENT_PASSWORD_VERSION`] to the new version number.
//! 3. Ship a new client release. Old clients will still decrypt old files
//!    (they have the old password in their binary) but will fail on new
//!    files with a clear "unsupported password version: N (upgrade client)"
//!    error.

/// Mapping of password version number → password bytes.
///
/// Index 0 = v1 (initial release, 2026-07).
/// Append new entries for each new client release.
pub const PASSWORDS: &[(u8, &[u8])] = &[
    // v1 — initial release (2026-07-19)
    // Generated from a 40-byte random hex string. Replace with a fresh
    // random value before each production release.
    (1, b"ai00x-share-v1-7f3a9b2e8c5d1a4f6b9e0c2d3a5f7b8e"),
    // (2, b"ai00x-share-v2-..."),  // Future versions append here
];

/// The currently active password version used for packaging new files.
///
/// Must match one of the entries in [`PASSWORDS`].
pub const CURRENT_PASSWORD_VERSION: u8 = 1;

/// Get the password for the currently active version.
///
/// Used by the packager when creating new shareable FLAC files.
pub fn current_password() -> &'static [u8] {
    let (_, pwd) = PASSWORDS
        .iter()
        .find(|(v, _)| *v == CURRENT_PASSWORD_VERSION)
        .expect("CURRENT_PASSWORD_VERSION must exist in PASSWORDS");
    pwd
}

/// Look up a password by version number.
///
/// Returns `None` if the version is not in the embedded table — this means
/// the file was packaged by a newer client version and the user must upgrade
/// their client to decrypt it.
///
/// Used by the player when decrypting existing shareable FLAC files. The
/// player reads `password_version` from the file's APPLICATION block
/// payload header and looks up the corresponding password here.
pub fn password_by_version(version: u8) -> Option<&'static [u8]> {
    PASSWORDS
        .iter()
        .find(|(v, _)| *v == version)
        .map(|(_, pwd)| *pwd)
}

/// Returns the highest version number in the table (for diagnostics).
pub fn latest_version() -> u8 {
    PASSWORDS.iter().map(|(v, _)| *v).max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_password_is_in_table() {
        let pwd = current_password();
        assert!(
            password_by_version(CURRENT_PASSWORD_VERSION).is_some(),
            "CURRENT_PASSWORD_VERSION must exist in PASSWORDS"
        );
        assert_eq!(
            password_by_version(CURRENT_PASSWORD_VERSION),
            Some(pwd),
            "current_password() must match password_by_version(CURRENT_PASSWORD_VERSION)"
        );
    }

    #[test]
    fn password_by_version_returns_none_for_unknown() {
        // 255 is reserved for future use; current table only has v1
        assert_eq!(password_by_version(255), None);
        assert_eq!(password_by_version(0), None);
    }

    #[test]
    fn password_by_version_returns_some_for_v1() {
        let pwd = password_by_version(1);
        assert!(pwd.is_some(), "v1 password must be in the table");
        assert!(!pwd.unwrap().is_empty(), "password must not be empty");
    }

    #[test]
    fn latest_version_matches_current() {
        // Initially, CURRENT_PASSWORD_VERSION should equal latest_version()
        // (when no deprecated versions exist yet).
        assert_eq!(latest_version(), CURRENT_PASSWORD_VERSION);
    }

    #[test]
    fn passwords_are_unique() {
        // All passwords in the table must be unique.
        let mut seen = std::collections::HashSet::new();
        for (_, pwd) in PASSWORDS {
            assert!(
                seen.insert(*pwd),
                "duplicate password detected in PASSWORDS table"
            );
        }
    }

    #[test]
    fn versions_are_unique_and_sorted() {
        // Version numbers must be unique and monotonically increasing.
        let mut prev: Option<u8> = None;
        let mut seen = std::collections::HashSet::new();
        for (v, _) in PASSWORDS {
            assert!(seen.insert(*v), "duplicate version number: {}", v);
            if let Some(p) = prev {
                assert!(*v > p, "versions must be monotonically increasing");
            }
            prev = Some(*v);
        }
    }
}
