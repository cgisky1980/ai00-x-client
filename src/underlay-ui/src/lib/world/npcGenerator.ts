// ========================================================================
// NPC 生成器（客户端降级用）
// ========================================================================
// 与服务端 visits/request.ais 的 generateNPC 逻辑保持一致：
// - 基于 memberId 确定性生成（mulberry32）
// - 20 国籍名字池（每国 10 姓 × 10 男名 × 10 女名 = 4000 组合）
// - 随机 avatarData（head 5 × body 7 × hands 4 × glasses 4 = 560 种）
// - 性别、性格、时区、肤色按国籍匹配
// memberId 范围 1001-2000，共 1000 个确定性 NPC
// ========================================================================

import type { Neighbor, AvatarData, Personality } from '../api/types';

// ─── 名字池（20 国籍）───
const NAME_POOLS: Record<string, {
    s: string[]; m: string[]; f: string[];
}> = {
    China: { s: ['王','李','张','刘','陈','杨','黄','赵','周','吴'], m: ['伟','强','磊','军','勇','杰','涛','明','超','鹏'], f: ['芳','娜','敏','静','艳','霞','娟','婷','雪','梅'] },
    Japan: { s: ['佐藤','鈴木','高橋','田中','伊藤','渡辺','山本','中村','小林','加藤'], m: ['翔太','蓮','陽翔','樹','悠真','大翔','陽斗','湊','大和','颯太'], f: ['陽菜','凛','結愛','紗枝','美桜','楓','莉子','結衣','咲良','葵'] },
    Korea: { s: ['金','李','朴','崔','郑','姜','赵','尹','张','林'], m: ['민준','서준','도윤','예준','시우','주원','하준','지호','지훈','준서'], f: ['서아','지아','서윤','하윤','서진','지유','수아','하린','아윤','하은'] },
    USA: { s: ['Smith','Johnson','Williams','Brown','Jones','Davis','Miller','Wilson','Moore','Taylor'], m: ['James','John','Robert','Michael','William','David','Joseph','Charles','Thomas','Daniel'], f: ['Mary','Patricia','Jennifer','Linda','Elizabeth','Barbara','Susan','Jessica','Sarah','Karen'] },
    UK: { s: ['Smith','Jones','Williams','Brown','Taylor','Davies','Wilson','Evans','Thomas','Roberts'], m: ['Oliver','George','Harry','Jack','Jacob','Noah','Charlie','Thomas','Oscar','Henry'], f: ['Olivia','Amelia','Isla','Ava','Mia','Isabella','Sophia','Grace','Lily','Freya'] },
    Germany: { s: ['Müller','Schmidt','Schneider','Fischer','Weber','Meyer','Wagner','Becker','Schulz','Hoffmann'], m: ['Lukas','Leon','Felix','Maximilian','Paul','Jonas','Tim','Niklas','Finn','Elias'], f: ['Sophie','Marie','Anna','Lena','Emma','Mia','Hannah','Lina','Mila','Ella'] },
    France: { s: ['Martin','Bernard','Dubois','Thomas','Robert','Richard','Petit','Durand','Leroy','Moreau'], m: ['Lucas','Léo','Gabriel','Louis','Arthur','Jules','Adam','Raphaël','Nathan','Hugo'], f: ['Emma','Jade','Louise','Alice','Chloé','Lina','Léa','Rose','Anna','Inès'] },
    Italy: { s: ['Rossi','Russo','Ferrari','Esposito','Bianchi','Romano','Colombo','Ricci','Marino','Greco'], m: ['Lorenzo','Alessandro','Mattia','Leonardo','Francesco','Tommaso','Riccardo','Gabriele','Edoardo','Diego'], f: ['Sofia','Giulia','Aurora','Beatrice','Alice','Ginevra','Emma','Giorgia','Vittoria','Matilde'] },
    Spain: { s: ['García','Rodríguez','González','Fernández','López','Martínez','Sánchez','Pérez','Gómez','Martín'], m: ['Hugo','Martín','Daniel','Pablo','Alejandro','Lucas','Mateo','Adrián','Álvaro','Diego'], f: ['Lucía','Sofía','Martina','María','Julia','Paula','Valeria','Daniela','Carmen','Noa'] },
    Brazil: { s: ['Silva','Santos','Oliveira','Souza','Rodrigues','Ferreira','Alves','Pereira','Lima','Costa'], m: ['Miguel','Arthur','Heitor','Bernardo','Davi','Théo','Lorenzo','Gabriel','Pedro','Matheus'], f: ['Helena','Alice','Manuela','Valentina','Sophia','Laura','Beatriz','Maria','Yasmin','Júlia'] },
    Russia: { s: ['Ivanov','Smirnov','Kuznetsov','Popov','Vasiliev','Petrov','Sokolov','Mikhailov','Fedorov','Volkov'], m: ['Alexander','Mikhail','Ivan','Dmitri','Maxim','Sergei','Nikolai','Andrei','Alexei','Roman'], f: ['Anastasia','Maria','Sofia','Anna','Victoria','Daria','Polina','Ekaterina','Alena','Ksenia'] },
    India: { s: ['Sharma','Verma','Patel','Gupta','Singh','Kumar','Shah','Mehta','Joshi','Reddy'], m: ['Aarav','Vihaan','Aditya','Arjun','Sai','Reyansh','Krishna','Ishaan','Rohan','Arnav'], f: ['Saanvi','Aanya','Aadhya','Ananya','Pari','Diya','Myra','Riya','Anika','Navya'] },
    Thailand: { s: ['Saetang','Somsak','Boonmee','Charoen','Suwan','Phakdee','Kiat','Srisai','Pongchai','Wong'], m: ['Arthit','Chai','Krit','Nattawut','Prasit','Somchai','Thanawat','Wichai','Apichat','Boonsit'], f: ['Anong','Busaba','Chanida','Kamonchanok','Mali','Naree','Pim','Siriporn','Suchada','Wassana'] },
    Vietnam: { s: ['Nguyễn','Trần','Lê','Phạm','Hoàng','Phan','Vũ','Võ','Đặng','Bùi'], m: ['Minh','Nam','Hùng','Dũng','Long','Quân','Hải','Tuấn','Bảo','Đức'], f: ['Lan','Hoa','Mai','Hương','Linh','Ngọc','Quỳnh','Thảo','Trang','Yến'] },
    Mexico: { s: ['Hernández','García','Martínez','López','González','Pérez','Rodríguez','Sánchez','Ramírez','Cruz'], m: ['Mateo','Santiago','Matías','Diego','Sebastián','Miguel','Ángel','Iker','Alejandro','Emiliano'], f: ['Sofía','Valentina','Regina','María','Camila','Renata','Guadalupe','Ximena','Victoria','Fernanda'] },
    Canada: { s: ['Smith','Brown','Tremblay','Martin','Roy','Gagnon','Lee','Wilson','Johnson','MacDonald'], m: ['Liam','Noah','Oliver','William','Benjamin','Lucas','Henry','Theodore','Jack','Levi'], f: ['Olivia','Emma','Charlotte','Amelia','Sophia','Ava','Mia','Isabella','Riley','Aria'] },
    Australia: { s: ['Smith','Jones','Williams','Brown','Wilson','Taylor','Johnson','White','Martin','Anderson'], m: ['Oliver','Noah','Jack','William','Leo','Lucas','Thomas','Henry','Charlie','Hudson'], f: ['Charlotte','Olivia','Amelia','Isla','Mia','Ava','Grace','Willow','Chloe','Ivy'] },
    Netherlands: { s: ['De Jong','Jansen','De Vries','Van den Berg','Van Dijk','Bakker','Janssen','Visser','Smit','Meijer'], m: ['Daan','Sem','Lucas','Lev','Noud','Bram','Lars','Finn','Jesse','Mees'], f: ['Emma','Sophie','Zoë','Sara','Mila','Tess','Lotte','Lina','Liva','Evi'] },
    Sweden: { s: ['Andersson','Johansson','Karlsson','Nilsson','Eriksson','Larsson','Olsson','Persson','Svensson','Gustafsson'], m: ['Liam','Noah','Lucas','Elias','William','Oliver','Hugo','Matteo','Leo','Charlie'], f: ['Alice','Maja','Lilly','Elsa','Astrid','Wilma','Ebba','Olivia','Alicia','Molly'] },
    Egypt: { s: ['Mohamed','Ahmed','Ali','Hassan','Ibrahim','Mahmoud','Abdelrahman','Said','Khaled','Mostafa'], m: ['Mohamed','Ahmed','Omar','Ali','Youssef','Mahmoud','Karim','Hassan','Khaled','Amr'], f: ['Mariam','Fatma','Aya','Yasmin','Salma','Habiba','Menna','Aisha','Nour','Jana'] },
};

// ─── 头部色池（全色环风格化，不绑定人种，28 色）───
// 自然肤色 + 暖色 + 冷色 + 绿色 + 中性色，最大化视觉辨识度
const SKIN_COLORS = [
    // 自然肤色（8 色）
    '#f5e8c8','#ebdfad','#e8b890','#d8a878','#c89868','#a87850','#885838','#784830',
    // 暖色风格化（6 色：珊瑚/桃红/橙红/暖橙/浅粉/玫瑰粉）
    '#f5b8a0','#e89888','#d88870','#c87858','#e0a8b8','#d098a8',
    // 冷色风格化（6 色：天蓝/雾蓝/灰蓝/淡蓝紫/蓝灰/浅紫蓝）
    '#a8c8d8','#88a8c0','#7898a8','#98a8c8','#8898b8','#a8b8d8',
    // 绿色系（4 色：薄荷/鼠尾草/浅翠/暖绿）
    '#a8c8a0','#88b890','#98c8a8','#78a888',
    // 中性色（4 色：暖灰/米灰/深灰/炭灰）
    '#d8d0c8','#b8b0a8','#888078','#585048',
];

// ─── 裤子/腿部布料色池（12 色，覆盖全色环，增加视觉多样性）───
const PANTS_COLORS = [
    '#2c3e50', // 深蓝
    '#34495e', // 炭灰
    '#1a1a1a', // 黑
    '#4a4a4a', // 深灰
    '#6b5b3e', // 卡其
    '#3d3d3d', // 暗灰
    '#1e3a5f', // 藏青
    '#4a1a1a', // 酒红
    '#2d4a2d', // 橄榄绿
    '#3d2a1a', // 深棕
    '#4a3a5a', // 深紫
    '#5a4a3a', // 暖棕
];

const HEADS = ['01','02','03','04','05'];
const BODIES = ['01','05','10','15','18','20','25'];
const HANDS = ['01','03','05','07'];
const GLASSES = ['none','none','none','01','10','15']; // none 概率更高
const PLANT_TYPES = ['sunflower','daisy','lavender','mimosa','cactus'];
const COUNTRY_KEYS = Object.keys(NAME_POOLS);

const TZ_MAP: Record<string, string> = {
    China: 'Asia/Shanghai', Japan: 'Asia/Tokyo', Korea: 'Asia/Seoul',
    USA: 'America/New_York', UK: 'Europe/London', Germany: 'Europe/Berlin',
    France: 'Europe/Paris', Italy: 'Europe/Rome', Spain: 'Europe/Madrid',
    Brazil: 'America/Sao_Paulo', Russia: 'Europe/Moscow', India: 'Asia/Kolkata',
    Thailand: 'Asia/Bangkok', Vietnam: 'Asia/Ho_Chi_Minh', Mexico: 'America/Mexico_City',
    Canada: 'America/Toronto', Australia: 'Australia/Sydney', Netherlands: 'Europe/Amsterdam',
    Sweden: 'Europe/Stockholm', Egypt: 'Africa/Cairo',
};

/** mulberry32 确定性随机数生成器 */
function mulberry32(seed: number): () => number {
    let s = seed;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 基于 memberId 确定性生成 NPC（memberId 1001-2000） */
export function generateNpc(memberId: number): Neighbor {
    const rand = mulberry32(memberId * 7919);
    const country = COUNTRY_KEYS[Math.floor(rand() * COUNTRY_KEYS.length)];
    const pool = NAME_POOLS[country];
    const gender = rand() < 0.5 ? 'male' : 'female';
    const surname = pool.s[Math.floor(rand() * pool.s.length)];
    const givenName = gender === 'male'
        ? pool.m[Math.floor(rand() * pool.m.length)]
        : pool.f[Math.floor(rand() * pool.f.length)];
    // 中日韩越：姓+名；其他：FirstName LastName
    const username =
        country === 'China' || country === 'Japan' || country === 'Korea' || country === 'Vietnam'
            ? surname + givenName
            : `${givenName} ${surname}`;

    const headColor = SKIN_COLORS[Math.floor(rand() * SKIN_COLORS.length)];

    const avatarData: AvatarData = {
        parts: {
            head: HEADS[Math.floor(rand() * HEADS.length)],
            body: BODIES[Math.floor(rand() * BODIES.length)],
            hands: HANDS[Math.floor(rand() * HANDS.length)],
            legs: '01',
            eye: 'default',
            glasses: GLASSES[Math.floor(rand() * GLASSES.length)],
            clothes: 'none',
            effects: '01',
            weapons: '01',
        },
        colors: {
            Head: headColor,
            Hand_F: headColor,  // 手跟随肤色
            Hand_B: headColor,
            Leg_F: '#f0f0f0',   // 占位，下方 pantsColor 覆盖
            Leg_B: '#f0f0f0',
        },
    };

    const personality: Personality = {
        activity: 0.3 + rand() * 0.6,
        sociability: 0.3 + rand() * 0.6,
        plantPreference: PLANT_TYPES[Math.floor(rand() * PLANT_TYPES.length)],
    };

    // 裤子色（rand 消费放在 personality 之后，保持现有 NPC 的 head/body/hands/glasses/personality 不变）
    const pantsColor = PANTS_COLORS[Math.floor(rand() * PANTS_COLORS.length)];
    avatarData.colors.Leg_F = pantsColor;
    avatarData.colors.Leg_B = pantsColor;

    return {
        memberId,
        username,
        country,
        gender,
        personality,
        activeWindow: { start: '08:00', end: '23:00', timezone: TZ_MAP[country] ?? 'UTC' },
        avatarData,
    };
}

/** 随机种子类型（与服务端一致） */
const SEED_TYPES = ['sunflower', 'daisy', 'lavender', 'mimosa', 'cactus'] as const;

/** 随机选一个种子类型 */
export function randomSeedType(): string {
    return SEED_TYPES[Math.floor(Math.random() * SEED_TYPES.length)];
}

/** NPC memberId 范围 */
export const NPC_ID_MIN = 1001;
export const NPC_ID_MAX = 2000;
export const NPC_POOL_SIZE = NPC_ID_MAX - NPC_ID_MIN + 1; // 1000
