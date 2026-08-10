//! Timestamp extraction and correction — ported from
//! `forced_aligner.cpp` (`extract_timestamp_classes`,
//! `fix_timestamp_classes`, `classes_to_timestamps`,
//! `_get_feat_extract_output_lengths`).

/// Compute the number of audio-pad tokens from the mel frame count.
/// Matches HF's `_get_feat_extract_output_lengths` (see processing_qwen3_asr.py).
///
/// Note: uses **floor** division (Python `//` semantics) via `div_euclid`,
/// not C++'s truncating `/`. The two diverge at boundary cases where
/// `input_lengths % 100 == 0` (e.g. n_len=100 → Python=13, C++=14). The HF
/// reference is Python, so we follow that.
pub fn feat_extract_output_lengths(input_lengths: i32) -> i32 {
    let input_lengths_leave = input_lengths % 100;
    let feat_lengths = (input_lengths_leave - 1).div_euclid(2) + 1;
    let feat_lengths = (feat_lengths - 1).div_euclid(2) + 1;
    (feat_lengths - 1).div_euclid(2) + 1 + (input_lengths / 100) * 13
}

/// For every position in `tokens` whose ID == `timestamp_token_id`, take the
/// argmax of the corresponding logit row → timestamp class.
pub fn extract_timestamp_classes(
    logits: &[f32],
    tokens: &[i32],
    timestamp_token_id: i32,
    n_classes: i32,
) -> Vec<i32> {
    let nc = n_classes as usize;
    let mut out = Vec::new();
    for (i, &tok) in tokens.iter().enumerate() {
        if tok == timestamp_token_id {
            let row = &logits[i * nc..(i + 1) * nc];
            let (best_idx, _) = row
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
                .unwrap_or((0, &0.0_f32));
            out.push(best_idx as i32);
        }
    }
    out
}

/// LIS-based anomaly correction (ported from HF `fix_timestamp`).
///
/// Finds the longest strictly non-decreasing subsequence, marks those as
/// "normal", and interpolates anomalous runs:
/// - Runs of length ≤ 2 → snap to the nearest normal neighbor.
/// - Longer runs → linear interpolation between left/right normal values.
pub fn fix_timestamp_classes(data: &[i32]) -> Vec<i32> {
    let n = data.len();
    if n == 0 {
        return Vec::new();
    }

    // O(n²) LIS (n is small — number of timestamp tokens, typically < 1000).
    let mut dp = vec![1_i32; n];
    let mut parent = vec![-1_i32; n];
    for i in 1..n {
        for j in 0..i {
            if data[j] <= data[i] && dp[j] + 1 > dp[i] {
                dp[i] = dp[j] + 1;
                parent[i] = j as i32;
            }
        }
    }
    let mut max_len = 0_i32;
    let mut max_idx = 0_usize;
    for (i, &dp_i) in dp.iter().enumerate().take(n) {
        if dp_i > max_len {
            max_len = dp_i;
            max_idx = i;
        }
    }

    let mut is_normal = vec![false; n];
    {
        let mut idx = max_idx as i32;
        while idx != -1 {
            is_normal[idx as usize] = true;
            idx = parent[idx as usize];
        }
    }

    let mut result = data.to_vec();
    let mut i = 0;
    while i < n {
        if !is_normal[i] {
            let mut j = i;
            while j < n && !is_normal[j] {
                j += 1;
            }
            let anomaly_count = j - i;

            let mut left_val: Option<i32> = None;
            for k in (0..i).rev() {
                if is_normal[k] {
                    left_val = Some(result[k]);
                    break;
                }
            }
            let mut right_val: Option<i32> = None;
            for k in j..n {
                if is_normal[k] {
                    right_val = Some(result[k]);
                    break;
                }
            }

            if anomaly_count <= 2 {
                for (k, item) in result.iter_mut().enumerate().take(j).skip(i) {
                    match (left_val, right_val) {
                        (Some(lv), Some(_rv)) => {
                            // Snap to whichever neighbor is closer in position.
                            if (k as i32 - (i as i32 - 1)) <= (j as i32 - k as i32) {
                                *item = lv;
                            } else {
                                *item = right_val.unwrap();
                            }
                        }
                        (Some(lv), None) => *item = lv,
                        (None, Some(rv)) => *item = rv,
                        (None, None) => {}
                    }
                }
            } else {
                match (left_val, right_val) {
                    (Some(lv), Some(rv)) => {
                        let step = (rv - lv) as f32 / (anomaly_count + 1) as f32;
                        for (k, item) in result.iter_mut().enumerate().take(j).skip(i) {
                            *item = (lv as f32 + step * (k - i + 1) as f32) as i32;
                        }
                    }
                    (Some(lv), None) => {
                        for item in result.iter_mut().take(j).skip(i) {
                            *item = lv;
                        }
                    }
                    (None, Some(rv)) => {
                        for item in result.iter_mut().take(j).skip(i) {
                            *item = rv;
                        }
                    }
                    (None, None) => {}
                }
            }

            i = j;
        } else {
            i += 1;
        }
    }

    result
}

/// Convert timestamp classes to seconds (`class * segment_time_ms / 1000`).
/// Uses integer-then-divide to avoid f32 rounding error on the `80ms` step
/// (e.g. class=25 → 2.0 s exactly, not 1.9999998).
pub fn classes_to_timestamps(classes: &[i32], segment_time_ms: i32) -> Vec<f32> {
    classes
        .iter()
        .map(|&c| (c as f32 * segment_time_ms as f32) / 1000.0_f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_feat_extract_output_lengths() {
        // For mel.n_len=100: leave=100%100=0 → feat=(-1)/2+1=0 → (0-1)/2+1=0 → 0 + (100/100)*13 = 13
        assert_eq!(feat_extract_output_lengths(100), 13);
        // For mel.n_len=200: leave=0 → 0 + (200/100)*13 = 26
        assert_eq!(feat_extract_output_lengths(200), 26);
    }

    #[test]
    fn test_lis_monotonic() {
        // Already monotonic → no changes.
        let data = vec![0, 1, 2, 3, 5, 8, 13];
        let fixed = fix_timestamp_classes(&data);
        assert_eq!(fixed, data);
    }

    #[test]
    fn test_lis_short_anomaly() {
        // Single anomaly (the 10 in the middle) should be snapped to a neighbor.
        let data = vec![0, 1, 10, 2, 3];
        let fixed = fix_timestamp_classes(&data);
        // Position 2 is anomaly. Left neighbor is 1, right is 2. Position 2 is
        // closer to position 1 (distance 1) than to position 3 (distance 1),
        // tie → C++ picks left when (k - (i-1)) <= (j - k), so 1.
        assert_eq!(fixed[2], 1);
    }

    #[test]
    fn test_classes_to_timestamps() {
        let classes = vec![0, 10, 25];
        let ts = classes_to_timestamps(&classes, 80);
        assert_eq!(ts, vec![0.0, 0.8, 2.0]);
    }
}
