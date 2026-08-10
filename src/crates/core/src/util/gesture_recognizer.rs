#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Direction {
    East = 0,
    NorthEast = 1,
    North = 2,
    NorthWest = 3,
    West = 4,
    SouthWest = 5,
    South = 6,
    SouthEast = 7,
}

impl Direction {
    fn from_delta(dx: f64, dy: f64) -> Self {
        let angle = dy.atan2(dx);
        let octant = ((angle + std::f64::consts::PI) / (std::f64::consts::PI / 4.0)).round() as i32;
        match octant % 8 {
            0 => Direction::West,
            1 => Direction::NorthWest,
            2 => Direction::North,
            3 => Direction::NorthEast,
            4 => Direction::East,
            5 => Direction::SouthEast,
            6 => Direction::South,
            7 => Direction::SouthWest,
            _ => Direction::East,
        }
    }

    fn to_char(self) -> char {
        char::from_digit(self as u32, 10).unwrap_or('0')
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GestureDirection {
    Clockwise,
    CounterClockwise,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MatchResult {
    Direction {
        name: String,
        confidence: f64,
    },
    Sequence {
        name: String,
        confidence: f64,
    },
    ClosedShape {
        name: String,
        direction: Option<GestureDirection>,
        confidence: f64,
    },
}

pub fn encode_8dir(points: &[(f64, f64)]) -> String {
    if points.len() < 2 {
        return String::new();
    }

    let simplified = douglas_peucker(points, 8.0);
    let mut code = String::new();
    let mut last_dir: Option<Direction> = None;

    for i in 1..simplified.len() {
        let dx = simplified[i].0 - simplified[i - 1].0;
        let dy = simplified[i].1 - simplified[i - 1].1;
        let dist = (dx * dx + dy * dy).sqrt();
        if dist < 5.0 {
            continue;
        }

        let dir = Direction::from_delta(dx, dy);
        if Some(dir) != last_dir {
            code.push(dir.to_char());
            last_dir = Some(dir);
        }
    }

    code
}

pub fn douglas_peucker(points: &[(f64, f64)], epsilon: f64) -> Vec<(f64, f64)> {
    if points.len() < 3 {
        return points.to_vec();
    }

    let mut max_dist = 0.0;
    let mut max_idx = 0;

    let start = points[0];
    let end = points[points.len() - 1];
    let line_len = ((end.0 - start.0).powi(2) + (end.1 - start.1).powi(2)).sqrt();

    if line_len < 0.001 {
        let mut result = vec![points[0]];
        if points.len() > 1 {
            result.push(points[points.len() - 1]);
        }
        return result;
    }

    for (i, point) in points.iter().enumerate().skip(1).take(points.len() - 2) {
        let dist = perpendicular_distance(*point, start, end, line_len);
        if dist > max_dist {
            max_dist = dist;
            max_idx = i;
        }
    }

    if max_dist > epsilon {
        let mut first = douglas_peucker(&points[..=max_idx], epsilon);
        let second = douglas_peucker(&points[max_idx..], epsilon);
        first.pop();
        first.extend(second);
        first
    } else {
        vec![points[0], points[points.len() - 1]]
    }
}

fn perpendicular_distance(
    point: (f64, f64),
    line_start: (f64, f64),
    line_end: (f64, f64),
    line_len: f64,
) -> f64 {
    let cross = ((point.0 - line_start.0) * (line_end.1 - line_start.1)
        - (point.1 - line_start.1) * (line_end.0 - line_start.0))
        .abs();
    cross / line_len
}

pub fn levenshtein_distance(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let m = a_chars.len();
    let n = b_chars.len();

    let mut prev = (0..=n).collect::<Vec<usize>>();
    let mut curr = vec![0usize; n + 1];

    for i in 1..=m {
        curr[0] = i;
        for j in 1..=n {
            let cost = if a_chars[i - 1] == b_chars[j - 1] {
                0
            } else {
                1
            };
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }

    prev[n]
}

pub fn detect_direction(points: &[(i32, i32)]) -> Option<String> {
    if points.len() < 2 {
        return None;
    }

    let start = (points[0].0 as f64, points[0].1 as f64);
    let end = (
        points[points.len() - 1].0 as f64,
        points[points.len() - 1].1 as f64,
    );
    let dx = end.0 - start.0;
    let dy = end.1 - start.1;
    let distance = (dx * dx + dy * dy).sqrt();

    if distance < 30.0 {
        return None;
    }

    let straightness = compute_straightness(points);
    if straightness < 0.75 {
        return None;
    }

    let angle = dy.atan2(dx).to_degrees();
    let name = if (-45.0..45.0).contains(&angle) {
        "swipe-right"
    } else if (45.0..135.0).contains(&angle) {
        "swipe-down"
    } else if (-135.0..-45.0).contains(&angle) {
        "swipe-up"
    } else {
        "swipe-left"
    };

    Some(name.to_string())
}

pub fn compute_straightness(points: &[(i32, i32)]) -> f64 {
    if points.len() < 2 {
        return 0.0;
    }

    let start = (points[0].0 as f64, points[0].1 as f64);
    let end = (
        points[points.len() - 1].0 as f64,
        points[points.len() - 1].1 as f64,
    );
    let direct = ((end.0 - start.0).powi(2) + (end.1 - start.1).powi(2)).sqrt();

    if direct < 0.001 {
        return 0.0;
    }

    let mut total = 0.0;
    for i in 1..points.len() {
        let dx = (points[i].0 - points[i - 1].0) as f64;
        let dy = (points[i].1 - points[i - 1].1) as f64;
        total += (dx * dx + dy * dy).sqrt();
    }

    if total < 0.001 {
        return 1.0;
    }

    direct / total
}

pub fn detect_closed_shape(points: &[(f64, f64)]) -> Option<MatchResult> {
    if points.len() < 3 {
        return None;
    }

    let simplified = douglas_peucker(points, 8.0);
    if simplified.len() < 3 {
        return None;
    }

    let start = simplified[0];
    let end = simplified[simplified.len() - 1];
    let total_len = path_length(&simplified);
    if total_len < 0.001 {
        return None;
    }

    let closure_dist = ((end.0 - start.0).powi(2) + (end.1 - start.1).powi(2)).sqrt();
    if closure_dist > total_len * 0.35 {
        return None;
    }

    let (min_x, max_x, min_y, max_y) = bounding_box(&simplified);
    let width = max_x - min_x;
    let height = max_y - min_y;
    if width < 5.0 || height < 5.0 {
        return None;
    }

    let aspect = height / width;
    let cx = (min_x + max_x) / 2.0;
    let cy = (min_y + max_y) / 2.0;

    let direction = compute_shape_direction(&simplified);

    let n = simplified.len();

    let circularity = compute_circularity(&simplified, cx, cy);

    if n <= 6 && circularity < 0.25 {
        let corners = detect_corners(&simplified);
        if corners >= 4 && aspect > 0.5 && aspect < 2.0 {
            return Some(MatchResult::ClosedShape {
                name: "rectangle".to_string(),
                direction,
                confidence: 0.85,
            });
        }
        if (3..=6).contains(&corners) && aspect > 0.3 && aspect < 3.0 {
            return Some(MatchResult::ClosedShape {
                name: "triangle".to_string(),
                direction,
                confidence: 0.85,
            });
        }
    }

    if circularity > 0.15 && aspect > 0.4 && aspect < 2.5 {
        return Some(MatchResult::ClosedShape {
            name: "circle".to_string(),
            direction,
            confidence: 0.85,
        });
    }

    None
}

fn path_length(points: &[(f64, f64)]) -> f64 {
    if points.len() < 2 {
        return 0.0;
    }
    let mut d = 0.0;
    for i in 1..points.len() {
        let dx = points[i].0 - points[i - 1].0;
        let dy = points[i].1 - points[i - 1].1;
        d += (dx * dx + dy * dy).sqrt();
    }
    d
}

fn bounding_box(points: &[(f64, f64)]) -> (f64, f64, f64, f64) {
    let mut min_x = f64::MAX;
    let mut max_x = f64::MIN;
    let mut min_y = f64::MAX;
    let mut max_y = f64::MIN;
    for p in points {
        if p.0 < min_x {
            min_x = p.0;
        }
        if p.0 > max_x {
            max_x = p.0;
        }
        if p.1 < min_y {
            min_y = p.1;
        }
        if p.1 > max_y {
            max_y = p.1;
        }
    }
    (min_x, max_x, min_y, max_y)
}

fn detect_corners(points: &[(f64, f64)]) -> usize {
    if points.len() < 3 {
        return 0;
    }

    let mut corner_count = 0;

    for i in 1..points.len() - 1 {
        let dx1 = points[i].0 - points[i - 1].0;
        let dy1 = points[i].1 - points[i - 1].1;
        let dx2 = points[i + 1].0 - points[i].0;
        let dy2 = points[i + 1].1 - points[i].1;

        let len1 = (dx1 * dx1 + dy1 * dy1).sqrt();
        let len2 = (dx2 * dx2 + dy2 * dy2).sqrt();
        if len1 < 1.0 || len2 < 1.0 {
            continue;
        }

        let dot = (dx1 / len1) * (dx2 / len2) + (dy1 / len1) * (dy2 / len2);
        let angle_change = dot.clamp(-1.0, 1.0).acos().to_degrees();

        if angle_change > 45.0 {
            corner_count += 1;
        }
    }

    corner_count
}

fn compute_circularity(points: &[(f64, f64)], cx: f64, cy: f64) -> f64 {
    if points.len() < 4 {
        return 0.0;
    }

    let radii: Vec<f64> = points
        .iter()
        .map(|(x, y)| ((x - cx).powi(2) + (y - cy).powi(2)).sqrt())
        .collect();

    let mean = radii.iter().sum::<f64>() / radii.len() as f64;
    if mean < 1.0 {
        return 0.0;
    }

    let variance = radii.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / radii.len() as f64;
    let std_dev = variance.sqrt();

    1.0 - (std_dev / mean).min(1.0)
}

fn compute_shape_direction(points: &[(f64, f64)]) -> Option<GestureDirection> {
    if points.len() < 3 {
        return None;
    }

    let mut sum = 0.0;
    for i in 0..points.len() - 1 {
        sum += (points[i].0 * points[i + 1].1) - (points[i].1 * points[i + 1].0);
    }

    if sum > 0.0 {
        Some(GestureDirection::CounterClockwise)
    } else if sum < 0.0 {
        Some(GestureDirection::Clockwise)
    } else {
        None
    }
}

pub fn match_direction_sequence(code: &str, templates: &[(&str, &str)]) -> Option<(String, f64)> {
    if code.is_empty() {
        return None;
    }

    let mut best_name: Option<String> = None;
    let mut best_dist = usize::MAX;
    let mut best_len = code.len();

    for (name, template) in templates {
        let d = levenshtein_distance(code, template);
        let max_len = code.len().max(template.len());
        if max_len == 0 {
            continue;
        }

        if d < best_dist || (d == best_dist && max_len > best_len) {
            best_dist = d;
            best_name = Some(name.to_string());
            best_len = max_len;
        }
    }

    let max_len = best_len.max(1);
    let score = 1.0 - (best_dist as f64 / max_len as f64);

    if score > 0.5 {
        best_name.map(|n| (n, score))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_simple_arrow() {
        let points = vec![(10.0, 100.0), (50.0, 100.0), (100.0, 100.0), (150.0, 100.0)];
        let code = encode_8dir(&points);
        assert!(code.contains('0'));
    }

    #[test]
    fn test_encode_diagonal() {
        let points = vec![(10.0, 10.0), (50.0, 50.0), (100.0, 100.0)];
        let code = encode_8dir(&points);
        assert!(!code.is_empty());
    }

    #[test]
    fn test_levenshtein_identical() {
        assert_eq!(levenshtein_distance("000", "000"), 0);
    }

    #[test]
    fn test_levenshtein_substitution() {
        assert_eq!(levenshtein_distance("000", "666"), 3);
    }

    #[test]
    fn test_detect_direction_right() {
        let points = vec![(0, 100), (50, 100), (100, 100), (150, 100)];
        let result = detect_direction(&points);
        assert_eq!(result, Some("swipe-right".to_string()));
    }

    #[test]
    fn test_detect_direction_down() {
        let points = vec![(100, 0), (100, 50), (100, 100), (100, 150)];
        let result = detect_direction(&points);
        assert_eq!(result, Some("swipe-down".to_string()));
    }

    #[test]
    fn test_straightness_perfect() {
        let points = vec![(0, 0), (50, 0), (100, 0)];
        assert!((compute_straightness(&points) - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_douglas_peucker_straight_line() {
        let points = vec![
            (0.0, 0.0),
            (10.0, 0.0),
            (20.0, 0.0),
            (30.0, 0.0),
            (40.0, 0.0),
        ];
        let result = douglas_peucker(&points, 1.0);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], (0.0, 0.0));
        assert_eq!(result[1], (40.0, 0.0));
    }

    #[test]
    fn test_match_direction_sequence() {
        let templates = vec![("check", "71"), ("caret", "17"), ("arrow", "0")];
        let (name, score) = match_direction_sequence("0", &templates).unwrap();
        assert_eq!(name, "arrow");
        assert!((score - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_match_fuzzy() {
        let templates = vec![("arrow", "000")];
        let result = match_direction_sequence("0000", &templates);
        assert!(result.is_some());
        assert!(result.unwrap().1 > 0.6);
    }
}
