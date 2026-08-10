const NUM_POINTS: usize = 64;
const SQUARE_SIZE: f64 = 250.0;
const ANGLE_RANGE: f64 = std::f64::consts::FRAC_PI_4;
const ANGLE_PRECISION: f64 = 0.03490658503988659;
const HALF_DIAGONAL: f64 = 176.7766952966369;
const PHI: f64 = 0.5 * (-1.0 + 2.23606797749979);

#[derive(Debug, Clone, Copy)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    fn distance_to(&self, other: &Point) -> f64 {
        let dx = other.x - self.x;
        let dy = other.y - self.y;
        (dx * dx + dy * dy).sqrt()
    }
}

#[derive(Debug, Clone)]
pub struct Path2D {
    points: Vec<Point>,
}

impl Path2D {
    pub fn new(points: Vec<Point>) -> Self {
        Self { points }
    }

    fn len(&self) -> usize {
        self.points.len()
    }

    fn centroid(&self) -> Point {
        let n = self.points.len() as f64;
        let mut cx = 0.0;
        let mut cy = 0.0;
        for p in &self.points {
            cx += p.x;
            cy += p.y;
        }
        Point::new(cx / n, cy / n)
    }

    fn path_length(&self) -> f64 {
        let mut total = 0.0;
        for w in self.points.windows(2) {
            total += w[0].distance_to(&w[1]);
        }
        total
    }

    fn indicative_angle(&self) -> f64 {
        let c = self.centroid();
        let first = &self.points[0];
        (c.y - first.y).atan2(c.x - first.x)
    }

    fn resample(&self, n: usize) -> Path2D {
        if self.points.len() < 2 || n < 2 {
            return self.clone();
        }

        let interval = self.path_length() / (n as f64 - 1.0);
        if interval <= 0.0 {
            let mut pts = vec![self.points[0]; n];
            pts[n - 1] = self.points[self.points.len() - 1];
            return Path2D::new(pts);
        }

        let mut resampled = vec![self.points[0]];
        let mut d: f64 = 0.0;

        for i in 1..self.points.len() {
            let prev = &self.points[i - 1];
            let curr = &self.points[i];
            let dist = prev.distance_to(curr);

            if dist == 0.0 {
                continue;
            }

            while d + dist >= interval {
                let t = (interval - d) / dist;
                let nx = prev.x + t * (curr.x - prev.x);
                let ny = prev.y + t * (curr.y - prev.y);
                resampled.push(Point::new(nx, ny));

                if resampled.len() >= n {
                    break;
                }
                d = 0.0;
            }

            if resampled.len() >= n {
                break;
            }
            d += dist;
        }

        while resampled.len() < n {
            resampled.push(self.points[self.points.len() - 1]);
        }
        resampled.truncate(n);

        Path2D::new(resampled)
    }

    fn rotate_by(&self, radians: f64) -> Path2D {
        let c = self.centroid();
        let (sin, cos) = radians.sin_cos();
        Path2D::new(
            self.points
                .iter()
                .map(|p| {
                    let dx = p.x - c.x;
                    let dy = p.y - c.y;
                    Point::new(dx * cos - dy * sin + c.x, dx * sin + dy * cos + c.y)
                })
                .collect(),
        )
    }

    fn scale_to(&self, size: f64) -> Path2D {
        let (min_x, max_x, min_y, max_y) = self.bounding_box();
        let width = max_x - min_x;
        let height = max_y - min_y;

        if width <= 0.0 || height <= 0.0 {
            return self.clone();
        }

        Path2D::new(
            self.points
                .iter()
                .map(|p| Point::new(p.x * (size / width), p.y * (size / height)))
                .collect(),
        )
    }

    fn translate_to(&self, origin: Point) -> Path2D {
        let c = self.centroid();
        Path2D::new(
            self.points
                .iter()
                .map(|p| Point::new(p.x + origin.x - c.x, p.y + origin.y - c.y))
                .collect(),
        )
    }

    fn bounding_box(&self) -> (f64, f64, f64, f64) {
        let mut min_x = f64::MAX;
        let mut max_x = f64::MIN;
        let mut min_y = f64::MAX;
        let mut max_y = f64::MIN;

        for p in &self.points {
            if p.x < min_x {
                min_x = p.x;
            }
            if p.x > max_x {
                max_x = p.x;
            }
            if p.y < min_y {
                min_y = p.y;
            }
            if p.y > max_y {
                max_y = p.y;
            }
        }
        (min_x, max_x, min_y, max_y)
    }

    fn path_distance(&self, other: &Path2D) -> f64 {
        let n = self.points.len().min(other.points.len());
        if n == 0 {
            return f64::MAX;
        }
        let mut d = 0.0;
        for i in 0..n {
            d += self.points[i].distance_to(&other.points[i]);
        }
        d / n as f64
    }

    fn distance_at_angle(&self, template: &Path2D, radians: f64) -> f64 {
        let rotated = self.rotate_by(radians);
        rotated.path_distance(template)
    }

    fn distance_at_best_angle(
        &self,
        template: &Path2D,
        mut from_angle: f64,
        mut to_angle: f64,
        threshold: f64,
    ) -> f64 {
        let (mut x1, mut f1) = self.gss(from_angle, to_angle, template);
        let (mut x2, mut f2) = self.gss(to_angle, from_angle, template);

        while (to_angle - from_angle).abs() > threshold {
            if f1 < f2 {
                to_angle = x2;
                x2 = x1;
                f2 = f1;
                (x1, f1) = self.gss(from_angle, to_angle, template);
            } else {
                from_angle = x1;
                x1 = x2;
                f1 = f2;
                (x2, f2) = self.gss(to_angle, from_angle, template);
            }
        }

        f1.min(f2)
    }

    fn gss(&self, a: f64, b: f64, template: &Path2D) -> (f64, f64) {
        let x = PHI * a + (1.0 - PHI) * b;
        (x, self.distance_at_angle(template, x))
    }
}

#[derive(Debug, Clone)]
pub struct Template {
    pub name: String,
    pub path: Path2D,
}

impl Template {
    pub fn new(name: String, raw_points: &Path2D) -> Option<Template> {
        if raw_points.len() < 2 {
            return None;
        }
        let resampled = raw_points.resample(NUM_POINTS);
        let radians = resampled.indicative_angle();
        let rotated = resampled.rotate_by(-radians);
        let scaled = rotated.scale_to(SQUARE_SIZE);
        let translated = scaled.translate_to(Point::new(0.0, 0.0));
        Some(Template {
            name,
            path: translated,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GestureDirection {
    Clockwise,
    CounterClockwise,
}

pub struct Dollar1Recognizer {
    templates: Vec<Template>,
}

impl Dollar1Recognizer {
    pub fn new() -> Self {
        Self {
            templates: Vec::new(),
        }
    }

    pub fn add_template(&mut self, name: &str, raw_points: &[Point]) {
        let path = Path2D::new(raw_points.to_vec());
        if let Some(template) = Template::new(name.to_string(), &path) {
            self.templates.push(template);
        }
    }

    pub fn clear(&mut self) {
        self.templates.clear();
    }

    pub fn recognize(&self, raw_points: &[Point], score_threshold: f64) -> Option<(String, f64)> {
        if raw_points.len() < 2 || self.templates.is_empty() {
            return None;
        }

        let path = Path2D::new(raw_points.to_vec());
        let candidate = Template::new(String::new(), &path)?;

        let mut best_distance = f64::MAX;
        let mut best_name: Option<&str> = None;

        for template in &self.templates {
            let distance = candidate.path.distance_at_best_angle(
                &template.path,
                -ANGLE_RANGE,
                ANGLE_RANGE,
                ANGLE_PRECISION,
            );
            if distance < best_distance {
                best_distance = distance;
                best_name = Some(&template.name);
            }
        }

        let score = 1.0 - best_distance / HALF_DIAGONAL;

        if score >= score_threshold {
            best_name.map(|name| (name.to_string(), score))
        } else {
            None
        }
    }
}

impl Default for Dollar1Recognizer {
    fn default() -> Self {
        Self::new()
    }
}

pub fn compute_direction(points: &[Point]) -> Option<GestureDirection> {
    if points.len() < 3 {
        return None;
    }

    let path = Path2D::new(points.to_vec());
    let resampled = path.resample(NUM_POINTS);

    let mut sum = 0.0;
    for i in 0..resampled.len() - 1 {
        let a = &resampled.points[i];
        let b = &resampled.points[i + 1];
        sum += (a.x * b.y) - (a.y * b.x);
    }

    if sum > 0.0 {
        Some(GestureDirection::CounterClockwise)
    } else if sum < 0.0 {
        Some(GestureDirection::Clockwise)
    } else {
        None
    }
}
