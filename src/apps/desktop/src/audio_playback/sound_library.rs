use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SoundSource {
    Builtin,
    Generated { created_at: i64, prompt: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoundEntry {
    pub id: String,
    pub name: String,
    pub category: String,
    pub file_path: String,
    pub source: SoundSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoundCategory {
    pub id: String,
    pub name: String,
    pub sounds: Vec<SoundEntry>,
}

pub struct SoundLibrary {
    categories: Vec<SoundCategory>,
    sounds_dir: PathBuf,
}

impl SoundLibrary {
    pub fn new(sounds_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&sounds_dir)
            .map_err(|e| anyhow!("Failed to create sounds dir: {}", e))?;

        let mut lib = Self {
            categories: Vec::new(),
            sounds_dir,
        };

        lib.load_builtin_registry();
        lib.scan_all_categories()?;

        Ok(lib)
    }

    #[allow(clippy::type_complexity)]
    fn load_builtin_registry(&mut self) {
        let registry: Vec<(&str, &str, Vec<(&str, &str, &str)>)> = vec![
            (
                "nature",
                "自然",
                vec![
                    ("river", "河流", "mp3"),
                    ("waves", "海浪", "mp3"),
                    ("campfire", "篝火", "mp3"),
                    ("wind", "微风", "mp3"),
                    ("howling-wind", "狂风", "mp3"),
                    ("wind-in-trees", "林间风声", "mp3"),
                    ("waterfall", "瀑布", "mp3"),
                    ("walk-in-snow", "踏雪", "mp3"),
                    ("walk-on-leaves", "落叶", "mp3"),
                    ("walk-on-gravel", "碎石路", "mp3"),
                    ("droplets", "水滴", "mp3"),
                    ("jungle", "丛林", "mp3"),
                ],
            ),
            (
                "rain",
                "雨声",
                vec![
                    ("light-rain", "小雨", "mp3"),
                    ("heavy-rain", "大雨", "mp3"),
                    ("thunder", "雷声", "mp3"),
                    ("rain-on-window", "窗外雨", "mp3"),
                    ("rain-on-car-roof", "车顶雨", "mp3"),
                    ("rain-on-umbrella", "伞下雨", "mp3"),
                    ("rain-on-tent", "帐篷雨", "mp3"),
                    ("rain-on-leaves", "雨打叶", "mp3"),
                ],
            ),
            (
                "animals",
                "动物",
                vec![
                    ("birds", "鸟鸣", "mp3"),
                    ("seagulls", "海鸥", "mp3"),
                    ("crickets", "蟋蟀", "mp3"),
                    ("wolf", "狼嚎", "mp3"),
                    ("owl", "猫头鹰", "mp3"),
                    ("frog", "蛙鸣", "mp3"),
                    ("dog-barking", "狗叫", "mp3"),
                    ("horse-gallop", "马蹄声", "mp3"),
                    ("cat-purring", "猫咪呼噜", "mp3"),
                    ("crows", "乌鸦", "mp3"),
                    ("whale", "鲸鱼", "mp3"),
                    ("beehive", "蜂巢", "mp3"),
                    ("woodpecker", "啄木鸟", "mp3"),
                    ("chickens", "鸡", "mp3"),
                    ("cows", "牛", "mp3"),
                    ("sheep", "羊", "mp3"),
                ],
            ),
            (
                "urban",
                "城市",
                vec![
                    ("highway", "高速公路", "mp3"),
                    ("road", "道路", "mp3"),
                    ("ambulance-siren", "救护车", "mp3"),
                    ("busy-street", "繁华街道", "mp3"),
                    ("crowd", "人群", "mp3"),
                    ("traffic", "交通拥堵", "mp3"),
                    ("fireworks", "烟花", "mp3"),
                ],
            ),
            (
                "places",
                "场所",
                vec![
                    ("cafe", "咖啡馆", "mp3"),
                    ("airport", "机场", "mp3"),
                    ("church", "教堂", "mp3"),
                    ("temple", "寺庙", "mp3"),
                    ("construction-site", "工地", "mp3"),
                    ("underwater", "水下", "mp3"),
                    ("crowded-bar", "酒吧", "mp3"),
                    ("night-village", "夜间村庄", "mp3"),
                    ("subway-station", "地铁站", "mp3"),
                    ("office", "办公室", "mp3"),
                    ("supermarket", "超市", "mp3"),
                    ("carousel", "旋转木马", "mp3"),
                    ("laboratory", "实验室", "mp3"),
                    ("laundry-room", "洗衣房", "mp3"),
                    ("restaurant", "餐厅", "mp3"),
                    ("library", "图书馆", "mp3"),
                ],
            ),
            (
                "transport",
                "交通",
                vec![
                    ("train", "火车", "mp3"),
                    ("inside-a-train", "火车内部", "mp3"),
                    ("airplane", "飞机", "mp3"),
                    ("submarine", "潜水艇", "mp3"),
                    ("sailboat", "帆船", "mp3"),
                    ("rowing-boat", "划船", "mp3"),
                ],
            ),
            (
                "things",
                "物品",
                vec![
                    ("keyboard", "键盘", "mp3"),
                    ("typewriter", "打字机", "mp3"),
                    ("paper", "纸张", "mp3"),
                    ("clock", "时钟", "mp3"),
                    ("wind-chimes", "风铃", "mp3"),
                    ("singing-bowl", "颂钵", "mp3"),
                    ("ceiling-fan", "吊扇", "mp3"),
                    ("dryer", "烘干机", "mp3"),
                    ("slide-projector", "幻灯机", "mp3"),
                    ("boiling-water", "烧水", "mp3"),
                    ("bubbles", "气泡", "mp3"),
                    ("tuning-radio", "收音机调频", "mp3"),
                    ("morse-code", "摩尔斯电码", "mp3"),
                    ("washing-machine", "洗衣机", "mp3"),
                    ("vinyl-effect", "黑胶唱片", "mp3"),
                    ("windshield-wipers", "雨刮器", "mp3"),
                ],
            ),
            (
                "noise",
                "噪音",
                vec![
                    ("white-noise", "白噪音", "wav"),
                    ("pink-noise", "粉红噪音", "wav"),
                    ("brown-noise", "红噪音", "wav"),
                ],
            ),
        ];

        self.categories = registry
            .into_iter()
            .map(|(cat_id, cat_name, sounds)| SoundCategory {
                id: cat_id.to_string(),
                name: cat_name.to_string(),
                sounds: sounds
                    .into_iter()
                    .map(|(s_id, s_name, ext)| SoundEntry {
                        id: format!("builtin/{}/{}", cat_id, s_id),
                        name: s_name.to_string(),
                        category: cat_id.to_string(),
                        file_path: format!("{}/{}.{}", cat_id, s_id, ext),
                        source: SoundSource::Builtin,
                    })
                    .collect(),
            })
            .collect();
    }

    fn scan_all_categories(&mut self) -> Result<()> {
        // Scan all subdirectories under sounds_dir for audio files
        let entries = std::fs::read_dir(&self.sounds_dir)
            .map_err(|e| anyhow!("Failed to read sounds dir: {}", e))?;

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let dir_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            // Skip builtin categories (loaded from registry with Chinese names)
            // and legacy "Radio Favorites" (radio tracks are now real-time generated temp files)
            if matches!(
                dir_name.as_str(),
                "nature"
                    | "rain"
                    | "animals"
                    | "urban"
                    | "places"
                    | "transport"
                    | "things"
                    | "noise"
                    | "Radio Favorites"
                    | "radio_favorites"
            ) {
                continue;
            }

            // Find or create the category
            let cat_idx = self.categories.iter().position(|c| c.id == dir_name);
            let cat = match cat_idx {
                Some(idx) => &mut self.categories[idx],
                None => {
                    // Map known directory names to Chinese display names
                    let display_name = match dir_name.as_str() {
                        "generated" => "生成",
                        "custom" => "自定义",
                        "favorites" => "收藏",
                        other => other,
                    };
                    self.categories.push(SoundCategory {
                        id: dir_name.clone(),
                        name: display_name.to_string(),
                        sounds: Vec::new(),
                    });
                    self.categories.last_mut().unwrap()
                }
            };

            // Scan directory for audio files
            let file_entries = std::fs::read_dir(&path)
                .map_err(|e| anyhow!("Failed to read category dir {}: {}", dir_name, e))?;

            for file_entry in file_entries.flatten() {
                let file_path = file_entry.path();
                if !file_path.is_file() {
                    continue;
                }

                let ext = file_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if !matches!(ext.as_str(), "mp3" | "wav" | "ogg" | "flac") {
                    continue;
                }

                let file_name = file_path
                    .file_stem()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string();

                let id = format!("{}/{}", dir_name, file_name);
                let relative = format!(
                    "{}/{}",
                    dir_name,
                    file_path.file_name().unwrap_or_default().to_string_lossy()
                );

                // Don't add duplicates
                if cat.sounds.iter().any(|s| s.id == id) {
                    continue;
                }

                cat.sounds.push(SoundEntry {
                    id,
                    name: file_name,
                    category: dir_name.clone(),
                    file_path: relative,
                    source: SoundSource::Generated {
                        created_at: 0,
                        prompt: String::new(),
                    },
                });
            }
        }

        Ok(())
    }

    pub fn list_categories(&self) -> Vec<SoundCategory> {
        // Filter out legacy "Radio Favorites" category
        self.categories
            .iter()
            .filter(|c| c.id != "Radio Favorites" && c.id != "radio_favorites")
            .cloned()
            .collect()
    }

    pub fn sounds_dir(&self) -> &Path {
        &self.sounds_dir
    }

    pub fn get_sound_path(&self, id: &str) -> Option<PathBuf> {
        for cat in &self.categories {
            for sound in &cat.sounds {
                if sound.id == id {
                    return Some(self.sounds_dir.join(&sound.file_path));
                }
            }
        }
        None
    }

    pub fn save_to_library(
        &mut self,
        source_path: &str,
        category: &str,
        name: &str,
        prompt: &str,
    ) -> Result<SoundEntry> {
        let src = Path::new(source_path);
        if !src.exists() {
            return Err(anyhow!("Source file not found: {}", source_path));
        }

        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("mp3")
            .to_string();

        let category_dir = self.sounds_dir.join(category);
        std::fs::create_dir_all(&category_dir)
            .map_err(|e| anyhow!("Failed to create category dir: {}", e))?;

        let safe_name = name.replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "_");
        let file_name = format!("{}.{}", safe_name, ext);
        let dest = category_dir.join(&file_name);

        std::fs::copy(src, &dest).map_err(|e| anyhow!("Failed to copy file: {}", e))?;

        // Remove source file (radio temp files should be moved, not copied)
        let _ = std::fs::remove_file(src);

        let id = format!("{}/{}", category, safe_name);
        let relative = format!("{}/{}", category, file_name);

        let entry = SoundEntry {
            id,
            name: name.to_string(),
            category: category.to_string(),
            file_path: relative,
            source: SoundSource::Generated {
                created_at: chrono::Utc::now().timestamp(),
                prompt: prompt.to_string(),
            },
        };

        // Add to the appropriate category
        if let Some(cat) = self.categories.iter_mut().find(|c| c.id == category) {
            cat.sounds.push(entry.clone());
        } else {
            let display_name = match category {
                "generated" => "生成",
                "custom" => "自定义",
                "favorites" => "收藏",
                other => other,
            };
            self.categories.push(SoundCategory {
                id: category.to_string(),
                name: display_name.to_string(),
                sounds: vec![entry.clone()],
            });
        }

        log::info!(
            "Sound saved to library: id={}, path={}",
            entry.id,
            entry.file_path
        );
        Ok(entry)
    }

    pub fn delete_sound(&mut self, id: &str) -> Result<()> {
        let mut found_entry: Option<SoundEntry> = None;

        for cat in &mut self.categories {
            if let Some(idx) = cat.sounds.iter().position(|s| s.id == id) {
                let entry = cat.sounds.remove(idx);
                found_entry = Some(entry);
                break;
            }
        }

        let entry = found_entry.ok_or_else(|| anyhow!("Sound '{}' not found", id))?;

        // Only allow deleting Generated sounds
        match &entry.source {
            SoundSource::Builtin => {
                return Err(anyhow!("Cannot delete builtin sound"));
            }
            SoundSource::Generated { .. } => {}
        }

        let file_path = self.sounds_dir.join(&entry.file_path);
        if file_path.exists() {
            std::fs::remove_file(&file_path)
                .map_err(|e| anyhow!("Failed to delete file: {}", e))?;
        }

        log::info!("Sound deleted from library: id={}", id);
        Ok(())
    }

    pub fn reload(&mut self) -> Result<()> {
        self.categories.clear();
        self.load_builtin_registry();
        self.scan_all_categories()?;
        Ok(())
    }
}
