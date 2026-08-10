import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Globe, X, MapPin, ArrowLeft, Plus, Minus, Maximize } from 'lucide-react';

interface ZhMap {
  provinces: Record<string, string>;
}

let zhMapCache: ZhMap | null = null;
let zhMapLoadingPromise: Promise<ZhMap> | null = null;

async function loadZhMap(dataBaseUrl: string): Promise<ZhMap> {
  if (zhMapCache) return zhMapCache;
  if (zhMapLoadingPromise) return zhMapLoadingPromise;
  zhMapLoadingPromise = fetch(`${dataBaseUrl}/cn-zh.json`)
    .then((r) => r.json())
    .then((m: ZhMap) => {
      zhMapCache = m;
      return m;
    })
    .finally(() => {
      zhMapLoadingPromise = null;
    });
  return zhMapLoadingPromise;
}

function getProvinceZh(provinceTitle: string, zh: ZhMap | null): string {
  if (!zh) return provinceTitle;
  if (zh.provinces[provinceTitle]) return zh.provinces[provinceTitle];
  for (const [adminRegion, zhName] of Object.entries(zh.provinces)) {
    if (matchProvince(adminRegion, provinceTitle)) return zhName;
  }
  return provinceTitle;
}

const ISO2_TO_SLUG: Record<string, string> = {
  'AD': 'andorra',
  'AE': 'united-arab-emirates',
  'AL': '',
  'AM': 'armenia',
  'AO': 'angola',
  'AR': 'argentina',
  'AT': 'austria',
  'AU': 'australia',
  'AZ': 'azerbaijan',
  'BA': 'bosnia-herzegovina-1',
  'BB': '',
  'BD': 'bangladesh',
  'BE': 'belgium',
  'BF': 'burkina-faso',
  'BG': 'bulgaria',
  'BH': 'bahrain',
  'BI': 'burundi',
  'BJ': '',
  'BN': 'brunei-darussalam',
  'BO': 'bolivia',
  'BR': 'brazil',
  'BS': 'bahamas',
  'BT': 'bhutan',
  'BW': 'botswana',
  'BY': 'belarus',
  'BZ': '',
  'CA': 'canada',
  'CD': 'congo-dr',
  'CF': 'central-african-republic',
  'CG': 'congo',
  'CH': 'switzerland',
  'CI': 'ivory-coast',
  'CL': 'chile',
  'CM': 'cameroon',
  'CN': 'china',
  'CO': 'colombia',
  'CR': 'costa-rica',
  'CU': 'cuba',
  'CV': 'cape-verde',
  'CY': 'cyprus',
  'CZ': 'czech-republic',
  'DE': 'germany',
  'DJ': 'djibouti',
  'DK': 'denmark',
  'DO': 'dominican-republic',
  'DZ': '',
  'EC': 'ecuador',
  'EE': 'estonia',
  'EG': 'egypt',
  'ES': 'spain-provinces',
  'ET': 'ethiopia',
  'FI': 'finland',
  'FJ': '',
  'FO': 'faroeIslands',
  'FR': 'france-departments',
  'GA': '',
  'GB': 'united-kingdom-counties',
  'GE': 'georgia',
  'GH': '',
  'GM': '',
  'GN': 'guinea',
  'GR': 'greece',
  'GT': 'guatemala',
  'GW': '',
  'GY': '',
  'HK': 'hong-kong',
  'HN': 'honduras',
  'HR': 'croatia',
  'HT': 'haiti',
  'HU': 'hungary',
  'ID': 'indonesia',
  'IE': 'ireland',
  'IL': 'israel',
  'IN': 'india',
  'IQ': 'iraq',
  'IR': 'iran',
  'IS': 'iceland',
  'IT': 'italy',
  'JM': 'jamaica',
  'JO': '',
  'JP': 'japan',
  'KE': 'kenya',
  'KG': 'kyrgyzstan',
  'KH': 'cambodia',
  'KP': '',
  'KR': 'south-korea',
  'KW': '',
  'KZ': 'kazakhstan',
  'LA': 'laos',
  'LB': '',
  'LI': 'liechtenstein',
  'LK': 'sri-lanka',
  'LR': '',
  'LS': '',
  'LT': 'lithuania',
  'LU': 'luxembourg',
  'LV': 'latvia',
  'LY': '',
  'MA': 'morocco',
  'MC': '',
  'MD': 'moldova',
  'ME': 'montenegro',
  'MG': '',
  'MK': 'macedonia',
  'ML': 'mali',
  'MM': 'myanmar',
  'MN': '',
  'MO': '',
  'MR': '',
  'MT': 'malta',
  'MU': '',
  'MW': '',
  'MX': 'mexico',
  'MZ': 'mozambique',
  'NA': 'namibia',
  'NE': '',
  'NG': 'nigeria',
  'NI': 'nicaragua',
  'NL': 'netherlands',
  'NO': 'norway',
  'NP': 'nepal',
  'NZ': 'new-zealand',
  'OM': 'oman',
  'PA': 'panama',
  'PE': 'peru',
  'PG': '',
  'PH': 'philippines',
  'PK': 'pakistan',
  'PL': 'poland',
  'PR': 'puerto-rico',
  'PS': 'palestine',
  'PT': 'portugal',
  'PY': 'paraguay',
  'QA': 'qatar',
  'RO': 'romania',
  'RS': 'serbia',
  'RU': 'russia',
  'RW': 'rwanda',
  'SA': 'saudi-arabia',
  'SD': 'sudan',
  'SE': 'sweden',
  'SG': 'singapore',
  'SI': 'slovenia',
  'SK': 'slovakia',
  'SL': 'sierra-leone',
  'SM': 'san-marino',
  'SN': '',
  'SO': '',
  'SR': '',
  'SS': '',
  'SV': 'el-salvador',
  'SY': 'syria',
  'SZ': '',
  'TD': 'chad',
  'TG': '',
  'TH': 'thailand',
  'TJ': 'tajikistan',
  'TL': '',
  'TM': '',
  'TN': '',
  'TR': 'turkey',
  'TT': '',
  'TW': 'china',
  'TZ': '',
  'UA': 'ukraine',
  'UG': 'uganda',
  'US': 'usa-full',
  'UY': 'uruguay',
  'UZ': 'uzbekistan',
  'VC': '',
  'VE': 'venezuela',
  'VN': 'vietnam',
  'XK': 'kosovo',
  'YE': 'yemen',
  'ZA': 'south-africa',
  'ZM': 'zambia',
  'ZW': 'zimbabwe',
};

const ISO2_TO_ZH: Record<string, string> = {
  'CN': '中国', 'US': '美国', 'JP': '日本', 'GB': '英国',
  'FR': '法国', 'DE': '德国', 'RU': '俄罗斯', 'CA': '加拿大',
  'AU': '澳大利亚', 'IN': '印度', 'BR': '巴西', 'KR': '韩国',
  'IT': '意大利', 'ES': '西班牙', 'MX': '墨西哥', 'ID': '印度尼西亚',
  'TH': '泰国', 'VN': '越南', 'PH': '菲律宾', 'MY': '马来西亚',
  'AR': '阿根廷', 'PL': '波兰', 'NL': '荷兰', 'BE': '比利时',
  'SE': '瑞典', 'NO': '挪威', 'FI': '芬兰', 'DK': '丹麦',
  'CH': '瑞士', 'AT': '奥地利', 'PT': '葡萄牙', 'GR': '希腊',
  'IE': '爱尔兰', 'CZ': '捷克', 'HU': '匈牙利', 'RO': '罗马尼亚',
  'BG': '保加利亚', 'HR': '克罗地亚', 'SK': '斯洛伐克', 'SI': '斯洛文尼亚',
  'RS': '塞尔维亚', 'UA': '乌克兰', 'BY': '白俄罗斯', 'LT': '立陶宛',
  'LV': '拉脱维亚', 'EE': '爱沙尼亚', 'IS': '冰岛', 'LU': '卢森堡',
  'MT': '马耳他', 'CY': '塞浦路斯', 'TR': '土耳其', 'IL': '以色列',
  'SA': '沙特阿拉伯', 'AE': '阿联酋', 'IR': '伊朗', 'IQ': '伊拉克',
  'PK': '巴基斯坦', 'BD': '孟加拉国', 'LK': '斯里兰卡', 'MM': '缅甸',
  'KH': '柬埔寨', 'LA': '老挝', 'NP': '尼泊尔', 'AF': '阿富汗',
  'KZ': '哈萨克斯坦', 'UZ': '乌兹别克斯坦', 'KG': '吉尔吉斯斯坦', 'TJ': '塔吉克斯坦',
  'EG': '埃及', 'NG': '尼日利亚', 'ZA': '南非', 'KE': '肯尼亚',
  'ET': '埃塞俄比亚', 'GH': '加纳', 'TZ': '坦桑尼亚', 'UG': '乌干达',
  'DZ': '阿尔及利亚', 'MA': '摩洛哥', 'CM': '喀麦隆', 'CI': '科特迪瓦',
  'CL': '智利', 'CO': '哥伦比亚', 'PE': '秘鲁', 'VE': '委内瑞拉',
  'EC': '厄瓜多尔', 'CU': '古巴', 'DO': '多米尼加', 'GT': '危地马拉',
  'BO': '玻利维亚', 'PY': '巴拉圭', 'UY': '乌拉圭', 'CR': '哥斯达黎加',
  'PA': '巴拿马', 'HN': '洪都拉斯', 'SV': '萨尔瓦多', 'NI': '尼加拉瓜',
  'HT': '海地', 'JM': '牙买加', 'TT': '特立尼达和多巴哥', 'PR': '波多黎各',
  'NZ': '新西兰', 'FJ': '斐济', 'PG': '巴布亚新几内亚', 'SG': '新加坡',
  'HK': '香港', 'MO': '澳门', 'TW': '台湾',
  'KP': '朝鲜', 'MN': '蒙古', 'PS': '巴勒斯坦', 'JO': '约旦',
  'LB': '黎巴嫩', 'SY': '叙利亚', 'KW': '科威特', 'QA': '卡塔尔',
  'BH': '巴林', 'OM': '阿曼', 'YE': '也门', 'SD': '苏丹',
  'LY': '利比亚', 'TN': '突尼斯', 'BW': '博茨瓦纳', 'NA': '纳米比亚',
  'ZM': '赞比亚', 'ZW': '津巴布韦', 'MZ': '莫桑比克', 'AO': '安哥拉',
  'MW': '马拉维', 'MG': '马达加斯加', 'SN': '塞内加尔', 'ML': '马里',
  'BF': '布基纳法索', 'NE': '尼日尔', 'TD': '乍得', 'CF': '中非',
  'CD': '刚果（金）', 'CG': '刚果（布）', 'RW': '卢旺达', 'BI': '布隆迪',
  'BJ': '贝宁', 'TG': '多哥', 'GA': '加蓬', 'GN': '几内亚',
  'SL': '塞拉利昂', 'LR': '利比里亚', 'GM': '冈比亚', 'GW': '几内亚比绍',
  'CV': '佛得角', 'ST': '圣多美和普林西比', 'SO': '索马里', 'SS': '南苏丹',
  'ER': '厄立特里亚', 'DJ': '吉布提', 'GQ': '赤道几内亚', 'MR': '毛里塔尼亚',
  'MU': '毛里求斯', 'SZ': '斯威士兰', 'LS': '莱索托', 'MK': '北马其顿',
  'ME': '黑山', 'XK': '科索沃', 'BA': '波黑',
  'AL': '阿尔巴尼亚', 'AD': '安道尔', 'LI': '列支敦士登', 'MC': '摩纳哥',
  'SM': '圣马力诺', 'VA': '梵蒂冈', 'GI': '直布罗陀', 'FO': '法罗群岛',
  'GL': '格陵兰', 'AM': '亚美尼亚', 'AZ': '阿塞拜疆', 'GE': '格鲁吉亚',
  'MD': '摩尔多瓦', 'BN': '文莱', 'TL': '东帝汶', 'BT': '不丹',
  'MV': '马尔代夫', 'BS': '巴哈马', 'BB': '巴巴多斯', 'GD': '格林纳达',
  'DM': '多米尼克', 'LC': '圣卢西亚', 'VC': '圣文森特', 'AG': '安提瓜和巴布达',
  'KN': '圣基茨和尼维斯', 'BZ': '伯利兹', 'GY': '圭亚那', 'SR': '苏里南',
  'TM': '土库曼斯坦',
};

function getCountryZh(name: string, isZh: boolean, iso2?: string): string {
  if (!isZh) return name;
  if (iso2 && ISO2_TO_ZH[iso2]) return ISO2_TO_ZH[iso2];
  return name;
}

const PROVINCE_ALIASES: Record<string, string[]> = {
  'Guangxi Zhuang': ['Guangxi'],
  'Nei Mongol': ['Inner Mongolia'],
  'Ningxia Hui': ['Ningxia'],
  'Quinghai': ['Qinghai'],
  'Xinjiang Uygur': ['Xinjiang'],
  'Xizang (Tibet)': ['Tibet', 'Xizang'],
};

function matchProvince(adminRegion: string, provinceTitle: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s*\(.*?\)/g, '').trim();
  const a = norm(adminRegion);
  const t = norm(provinceTitle);
  if (!a || !t) return false;
  if (a === t) return true;
  const aliases = PROVINCE_ALIASES[provinceTitle.trim()];
  if (aliases && aliases.some(al => norm(al) === a)) return true;
  if (t.startsWith(a) || a.startsWith(t.split(' ')[0])) return true;
  return false;
}

interface ProvincePath {
  id: string;
  title: string;
  d: string;
}

interface CountrySvgData {
  viewBox: { x: number; y: number; w: number; h: number };
  paths: ProvincePath[];
}

async function loadCountrySvg(dataBaseUrl: string, slug: string): Promise<CountrySvgData> {
  const resp = await fetch(`${dataBaseUrl}/maps/${slug}.svg`);
  const text = await resp.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  if (!svgEl) throw new Error('Invalid SVG');
  const width = parseFloat(svgEl.getAttribute('width') || '1000');
  const height = parseFloat(svgEl.getAttribute('height') || '500');
  const vbAttr = svgEl.getAttribute('viewBox');
  let vb = { x: 0, y: 0, w: width, h: height };
  if (vbAttr) {
    const parts = vbAttr.split(/[\s,]+/).map(Number);
    if (parts.length === 4) vb = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }
  const paths: ProvincePath[] = [];
  doc.querySelectorAll('path').forEach(p => {
    const d = p.getAttribute('d') || '';
    const id = p.getAttribute('id') || '';
    const title = p.getAttribute('title') || '';
    if (d) paths.push({ id, title, d });
  });
  return { viewBox: vb, paths };
}

const CHINA_SAR: Record<string, { iso2: string; provinceTitle: string; label: string }> = {
  'CN__TW': { iso2: 'TW', provinceTitle: 'Taiwan', label: '台湾' },
  'CN__HK': { iso2: 'HK', provinceTitle: 'Hong Kong', label: '香港' },
  'CN__MO': { iso2: 'MO', provinceTitle: 'Macau', label: '澳门' },
};

const OCEAN_COLOR = '#0c4a6e';
const OCEAN_GRADIENT_TOP = '#0e5a85';
const OCEAN_GRADIENT_BOT = '#082f49';
const COUNTRY_COLOR = '#16a34a';
const COUNTRY_STROKE = '#15803d';
const COUNTRY_HOVER = '#22c55e';
const PROVINCE_COLOR = '#16a34a';
const PROVINCE_STROKE = '#15803d';
const PROVINCE_HOVER = '#22c55e';
const PROVINCE_SELECTED = '#f59e0b';

const FULL_VIEW = { x: 0, y: 0, w: 1010, h: 666 };

export interface LocationPickerProps {
  value: string;
  onChange: (v: string) => void;
  inputStyle: React.CSSProperties;
  placeholder?: string;
  /** i18n 翻译函数（由各包注入） */
  t: (key: string) => string;
  /** 当前语言（en | zh），决定地图文字与显示 */
  locale: 'en' | 'zh';
  /** 地图数据根路径（默认 'data'，即 {base}/data/...） */
  dataBaseUrl?: string;
}

export function LocationPicker({
  value,
  onChange,
  inputStyle,
  placeholder,
  t,
  locale,
  dataBaseUrl = 'data',
}: LocationPickerProps) {
  const isZh = locale === 'zh';
  const [expanded, setExpanded] = useState(false);

  const [view, setView] = useState<'world' | 'country'>('world');
  const [selectedCountry, setSelectedCountry] = useState<{ name: string; slug: string; iso2: string } | null>(null);
  const [selectedProvince, setSelectedProvince] = useState<string | null>(null);

  const [worldData, setWorldData] = useState<CountrySvgData | null>(null);
  const [provinceData, setProvinceData] = useState<CountrySvgData | null>(null);
  const [zhMap, setZhMap] = useState<ZhMap | null>(null);

  const [loadingWorld, setLoadingWorld] = useState(false);
  const [loadingCountry, setLoadingCountry] = useState(false);

  const [hoverCountry, setHoverCountry] = useState<string | null>(null);
  const [hoverProvince, setHoverProvince] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState(FULL_VIEW);
  const [isDragging, setIsDragging] = useState(false);

  const svgRef = useRef<SVGSVGElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const worldLoadedRef = useRef(false);
  const dragRef = useRef<{ lastX: number; lastY: number; contentW: number; contentH: number; started: boolean } | null>(null);
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const pendingDx = useRef(0);
  const pendingDy = useRef(0);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    mouseDownPosRef.current = null;
    isDraggingRef.current = false;
    pendingDx.current = 0;
    pendingDy.current = 0;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setIsDragging(false);
  }, []);

  const backToWorld = useCallback(() => {
    setView('world');
    setSelectedCountry(null);
    setSelectedProvince(null);
    setProvinceData(null);
    setHoverCountry(null);
    setHoverProvince(null);
    setViewBox(worldData?.viewBox || FULL_VIEW);
    endDrag();
  }, [worldData, endDrag]);

  useEffect(() => {
    if (!expanded) {
      endDrag();
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (view === 'country') {
          backToWorld();
        } else {
          setExpanded(false);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, view, backToWorld, endDrag]);

  useEffect(() => {
    if (!expanded || worldLoadedRef.current) return;
    worldLoadedRef.current = true;
    setLoadingWorld(true);
    loadCountrySvg(dataBaseUrl, 'world')
      .then(data => {
        const SAR_MAP: Record<string, string> = { TW: 'Taiwan', HK: 'Hong Kong', MO: 'Macau' };
        data.paths.forEach(p => {
          if (SAR_MAP[p.id]) {
            p.title = 'China';
            p.id = 'CN__' + p.id;
          }
        });
        setWorldData(data);
        setViewBox(data.viewBox);
        setLoadingWorld(false);
      })
      .catch(() => setLoadingWorld(false));
  }, [expanded, dataBaseUrl]);

  useEffect(() => {
    if (!expanded) return;
    if (isZh) {
      if (!zhMapCache) {
        loadZhMap(dataBaseUrl)
          .then(setZhMap)
          .catch(() => {});
      } else {
        setZhMap(zhMapCache);
      }
    } else {
      setZhMap(null);
    }
  }, [expanded, isZh, dataBaseUrl]);

  const confirmSelection = useCallback((countryName: string, countryIso2: string, provinceTitle?: string) => {
    let result: string;
    if (isZh) {
      let countryZh: string;
      if (countryIso2 === 'CN' || countryIso2 === 'TW' || countryIso2 === 'HK' || countryIso2 === 'MO') {
        const sarSuffix: Record<string, string> = { TW: '中国台湾', HK: '中国香港', MO: '中国澳门' };
        countryZh = sarSuffix[countryIso2] || '中国';
      } else {
        countryZh = ISO2_TO_ZH[countryIso2] || countryName;
      }
      if (provinceTitle) {
        const provZh = getProvinceZh(provinceTitle, zhMap);
        result = countryIso2 === 'CN' ? `${provZh}` : `${provZh}, ${countryZh}`;
      } else {
        result = countryZh;
      }
    } else {
      result = provinceTitle ? `${provinceTitle}, ${countryName}` : countryName;
    }
    onChange(result);
    setExpanded(false);
    backToWorld();
  }, [isZh, zhMap, onChange, backToWorld]);

  const enterCountry = useCallback((iso2: string, title: string, preselectProvince?: string) => {
    if (iso2 === 'TW') {
      preselectProvince = 'Taiwan';
      iso2 = 'CN';
      title = 'China';
    }
    const slug = ISO2_TO_SLUG[iso2] || '';

    if (!slug) {
      confirmSelection(title, iso2);
      return;
    }

    setSelectedCountry({ name: title, slug, iso2 });
    setView('country');
    setSelectedProvince(null);
    setProvinceData(null);
    setHoverCountry(null);
    setHoverProvince(null);
    endDrag();

    setLoadingCountry(true);
    loadCountrySvg(dataBaseUrl, slug)
      .then(data => {
        setProvinceData(data);
        setViewBox(data.viewBox);
        setLoadingCountry(false);
        if (preselectProvince) {
          setSelectedProvince(preselectProvince);
        }
      })
      .catch(() => setLoadingCountry(false));
  }, [endDrag, confirmSelection, dataBaseUrl]);

  const selectProvince = useCallback((title: string) => {
    if (!selectedCountry) return;
    setSelectedProvince(title);
    confirmSelection(selectedCountry.name, selectedCountry.iso2, title);
  }, [selectedCountry, confirmSelection]);

  useEffect(() => {
    if (!expanded) return;
    const container = mapContainerRef.current;
    if (!container) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const ratio = viewBox.w / viewBox.h;
      const cRatio = rect.width / rect.height;
      let contentW: number, contentH: number, cx: number, cy: number;
      if (cRatio > ratio) {
        contentH = rect.height;
        contentW = contentH * ratio;
        cx = (rect.width - contentW) / 2;
        cy = 0;
      } else {
        contentW = rect.width;
        contentH = contentW / ratio;
        cx = 0;
        cy = (rect.height - contentH) / 2;
      }
      const px = (e.clientX - rect.left - cx) / contentW;
      const py = (e.clientY - rect.top - cy) / contentH;
      if (px < 0 || px > 1 || py < 0 || py > 1) return;
      setViewBox(vb => {
        const mx = vb.x + px * vb.w;
        const my = vb.y + py * vb.h;
        const scale = e.deltaY > 0 ? 1.2 : 1 / 1.2;
        const newW = Math.max(vb.w * 0.05, Math.min(vb.w * 20, vb.w * scale));
        const newH = newW * (vb.h / vb.w);
        const newX = mx - px * newW;
        const newY = my - py * newH;
        return { x: newX, y: newY, w: newW, h: newH };
      });
    };
    container.addEventListener('wheel', handler, { passive: false });
    return () => container.removeEventListener('wheel', handler);
  }, [expanded, viewBox.w, viewBox.h]);

  const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const container = mapContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ratio = viewBox.w / viewBox.h;
    if (!isFinite(ratio) || ratio <= 0) return;
    const cRatio = rect.width / rect.height;
    let contentW: number, contentH: number;
    if (cRatio > ratio) {
      contentH = rect.height;
      contentW = contentH * ratio;
    } else {
      contentW = rect.width;
      contentH = contentW / ratio;
    }
    if (!isFinite(contentW) || !isFinite(contentH) || contentW <= 0 || contentH <= 0) return;
    dragRef.current = { lastX: e.clientX, lastY: e.clientY, contentW, contentH, started: false };
    mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
    isDraggingRef.current = false;
    pendingDx.current = 0;
    pendingDy.current = 0;
  }, [viewBox.w, viewBox.h]);

  const flushPan = useCallback(() => {
    rafRef.current = null;
    const dx = pendingDx.current;
    const dy = pendingDy.current;
    pendingDx.current = 0;
    pendingDy.current = 0;
    if (dx === 0 && dy === 0) return;
    const drag = dragRef.current;
    if (!drag) return;
    setViewBox(vb => {
      const vbDx = (dx / drag.contentW) * vb.w;
      const vbDy = (dy / drag.contentH) * vb.h;
      if (!isFinite(vbDx) || !isFinite(vbDy)) return vb;
      return { ...vb, x: vb.x - vbDx, y: vb.y - vbDy };
    });
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onDocMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (!drag.started && mouseDownPosRef.current) {
        const totalDx = e.clientX - mouseDownPosRef.current.x;
        const totalDy = e.clientY - mouseDownPosRef.current.y;
        if (Math.abs(totalDx) > 5 || Math.abs(totalDy) > 5) {
          drag.started = true;
          isDraggingRef.current = true;
          setIsDragging(true);
        }
      }
      pendingDx.current += dx;
      pendingDy.current += dy;
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushPan);
      }
    };
    const onDocMouseUp = () => {
      endDrag();
    };
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
    return () => {
      document.removeEventListener('mousemove', onDocMouseMove);
      document.removeEventListener('mouseup', onDocMouseUp);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [expanded, flushPan, endDrag]);

  const zoomBy = (scale: number) => {
    setViewBox(vb => {
      const newW = Math.max(vb.w * 0.05, Math.min(vb.w * 20, vb.w * scale));
      const newH = newW * (vb.h / vb.w);
      const cx = vb.x + vb.w / 2;
      const cy = vb.y + vb.h / 2;
      return { x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH };
    });
  };

  const handleClear = () => {
    onChange('');
  };

  const toggleExpanded = () => {
    if (!expanded) {
      backToWorld();
    }
    setExpanded(!expanded);
  };

  const loading = loadingWorld || loadingCountry;

  const provinceList = provinceData?.paths ?? [];

  return (
    <div className="relative">
      <div className="flex gap-1">
        <input
          type="text"
          value={value}
          readOnly
          onClick={toggleExpanded}
          placeholder={placeholder}
          className="flex-1 rounded-lg border px-3 py-1.5 text-xs outline-none focus:border-[rgb(var(--primary))] cursor-pointer"
          style={inputStyle}
        />
        <button
          type="button"
          onClick={toggleExpanded}
          title={t('locationPick')}
          className="rounded-lg border px-2 py-1.5 text-xs transition-all hover:opacity-80"
          style={{
            borderColor: expanded ? 'rgb(var(--primary))' : 'var(--border)',
            background: expanded ? 'rgba(var(--primary), 0.15)' : 'var(--secondary)',
            color: expanded ? 'rgb(var(--primary))' : 'var(--text-50)',
          }}
        >
          <Globe className="w-4 h-4" />
        </button>
        {value && (
          <button
            type="button"
            onClick={handleClear}
            title={t('clear')}
            className="rounded-lg border px-2 py-1.5 text-xs transition-all hover:opacity-80"
            style={{ borderColor: 'var(--border)', color: 'var(--text-50)' }}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {expanded && createPortal(
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(2px)' }}
          onClick={() => setExpanded(false)}
        >
          <div
            className="rounded-xl border overflow-hidden flex flex-col shadow-2xl"
            style={{
              width: '92vw',
              maxWidth: '1200px',
              height: '88vh',
              maxHeight: '760px',
              borderColor: 'var(--border)',
              background: 'var(--card-bg)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-2 min-w-0">
                {view === 'country' && (
                  <button
                    type="button"
                    onClick={backToWorld}
                    className="rounded-md p-1 transition-all hover:opacity-70 flex-shrink-0"
                    style={{ color: 'var(--text-50)' }}
                    title={t('locationBackToWorld')}
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                )}
                <Globe className="w-4 h-4 flex-shrink-0" style={{ color: 'rgb(var(--primary))' }} />
                <span className="text-sm font-medium truncate" style={{ color: 'var(--text-90)' }}>
                  {view === 'world' ? t('locationPick') : selectedCountry ? getCountryZh(selectedCountry.name, isZh, selectedCountry.iso2) : ''}
                </span>
                {selectedProvince && (
                  <>
                    <span className="text-xs" style={{ color: 'var(--text-50)' }}>/</span>
                    <span className="text-xs truncate" style={{ color: 'rgb(var(--primary))' }}>
                      {getProvinceZh(selectedProvince, zhMap)}
                    </span>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="rounded-md p-1 transition-all hover:opacity-80 flex-shrink-0"
                style={{ color: 'var(--text-50)' }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 flex overflow-hidden">
              <div
                ref={mapContainerRef}
                className="flex-1 relative overflow-hidden"
                style={{
                  background: `linear-gradient(180deg, ${OCEAN_GRADIENT_TOP} 0%, ${OCEAN_COLOR} 50%, ${OCEAN_GRADIENT_BOT} 100%)`,
                }}
              >
                {loading && (
                  <div
                    className="absolute inset-0 flex items-center justify-center z-20"
                    style={{ color: 'white' }}
                  >
                    <Loader2 className="w-8 h-8 animate-spin" style={{ animationDuration: '1.2s' }} />
                  </div>
                )}

                {view === 'world' && worldData && (
                  <svg
                    ref={svgRef}
                    viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
                    preserveAspectRatio="xMidYMid meet"
                    onMouseDown={handleMouseDown}
                    className={`absolute inset-0 w-full h-full ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                    style={{ userSelect: 'none' }}
                  >
                    {worldData.paths.map(pp => {
                      const isSar = pp.id.startsWith('CN__');
                      const iso2 = isSar ? 'CN' : pp.id;
                      const hasSvg = !!ISO2_TO_SLUG[iso2];
                      const isHover = hoverCountry === iso2;
                      const displayTitle = isSar ? 'China' : pp.title;
                      return (
                        <path
                          key={pp.id}
                          d={pp.d}
                          fill={isHover ? COUNTRY_HOVER : COUNTRY_COLOR}
                          stroke={COUNTRY_STROKE}
                          strokeWidth={Math.max(0.3, viewBox.w / 800)}
                          strokeLinejoin="round"
                          opacity={hasSvg ? 1 : 0.6}
                          style={{ pointerEvents: 'all' }}
                          onMouseEnter={() => { if (!isDraggingRef.current) setHoverCountry(iso2); }}
                          onMouseLeave={() => { if (!isDraggingRef.current) setHoverCountry(null); }}
                          onClick={(e) => {
                            if (isDraggingRef.current) return;
                            e.stopPropagation();
                            if (isSar) {
                              const sarInfo = CHINA_SAR[pp.id];
                              if (sarInfo) {
                                enterCountry('CN', displayTitle, sarInfo.provinceTitle);
                              }
                            } else {
                              enterCountry(pp.id, pp.title);
                            }
                          }}
                        >
                          <title>{getCountryZh(displayTitle, isZh, iso2)}</title>
                        </path>
                      );
                    })}
                  </svg>
                )}

                {view === 'country' && provinceData && (
                  <svg
                    ref={svgRef}
                    viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
                    preserveAspectRatio="xMidYMid meet"
                    onMouseDown={handleMouseDown}
                    className={`absolute inset-0 w-full h-full ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                    style={{ userSelect: 'none' }}
                  >
                    {provinceData.paths.map(pp => {
                      const isHover = hoverProvince === pp.id;
                      const isSelected = selectedProvince === pp.title;
                      return (
                        <path
                          key={pp.id}
                          d={pp.d}
                          fill={isSelected ? PROVINCE_SELECTED : isHover ? PROVINCE_HOVER : PROVINCE_COLOR}
                          stroke={PROVINCE_STROKE}
                          strokeWidth={Math.max(0.5, viewBox.w / 800)}
                          strokeLinejoin="round"
                          style={{ pointerEvents: 'all', cursor: 'pointer' }}
                          onMouseEnter={() => { if (!isDraggingRef.current) setHoverProvince(pp.id); }}
                          onMouseLeave={() => { if (!isDraggingRef.current) setHoverProvince(null); }}
                          onClick={(e) => {
                            if (isDraggingRef.current) return;
                            e.stopPropagation();
                            selectProvince(pp.title);
                          }}
                        >
                          <title>{getProvinceZh(pp.title, zhMap)}</title>
                        </path>
                      );
                    })}
                  </svg>
                )}

                <div className="absolute bottom-3 left-3 flex flex-col gap-1 z-10">
                  <button
                    type="button"
                    onClick={() => zoomBy(1 / 1.6)}
                    className="rounded-md border w-9 h-9 flex items-center justify-center transition-all hover:opacity-80 shadow-lg"
                    style={{ borderColor: 'rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.95)', color: '#0c4a6e' }}
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => zoomBy(1.6)}
                    className="rounded-md border w-9 h-9 flex items-center justify-center transition-all hover:opacity-80 shadow-lg"
                    style={{ borderColor: 'rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.95)', color: '#0c4a6e' }}
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewBox(view === 'world' ? (worldData?.viewBox || FULL_VIEW) : (provinceData?.viewBox || FULL_VIEW))}
                    title={t('locationReset')}
                    className="rounded-md border w-9 h-9 flex items-center justify-center transition-all hover:opacity-80 shadow-lg"
                    style={{ borderColor: 'rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.95)', color: '#0c4a6e' }}
                  >
                    <Maximize className="w-4 h-4" />
                  </button>
                </div>

                <div
                  className="absolute bottom-3 right-3 px-2 py-1 rounded text-[10px] font-mono z-10"
                  style={{ background: 'rgba(0,0,0,0.5)', color: 'rgba(255,255,255,0.85)' }}
                >
                  {view === 'world'
                    ? `${((worldData?.viewBox.w || 1010) / viewBox.w).toFixed(1)}x`
                    : `${((provinceData?.viewBox.w || 1) / viewBox.w).toFixed(1)}x`}
                </div>
              </div>

              <div
                className="w-[280px] border-l flex flex-col flex-shrink-0"
                style={{ borderColor: 'var(--border)', background: 'var(--card-bg)' }}
              >
                <div
                  className="px-3 py-2 border-b text-xs font-medium flex items-center gap-1.5 flex-shrink-0"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-90)' }}
                >
                  <MapPin className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'rgb(var(--primary))' }} />
                  <span className="truncate">
                    {view === 'world'
                      ? t('locationClickCountryHint')
                      : selectedCountry
                      ? getCountryZh(selectedCountry.name, isZh, selectedCountry.iso2)
                      : ''}
                  </span>
                  {view === 'country' && provinceList.length > 0 && (
                    <span className="ml-auto text-[10px] flex-shrink-0" style={{ color: 'var(--text-50)' }}>
                      {provinceList.length}
                    </span>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto">
                  {view === 'world' ? (
                    <div
                      className="px-3 py-8 text-center text-xs"
                      style={{ color: 'var(--text-50)' }}
                    >
                      {loadingWorld ? t('locationLoading') : t('locationClickCountryHint')}
                    </div>
                  ) : view === 'country' && provinceData ? (
                    provinceList.map((pp, idx) => {
                      const provZh = getProvinceZh(pp.title, zhMap);
                      const isSelected = selectedProvince === pp.title;
                      const isHover = hoverProvince === pp.id;
                      return (
                        <button
                          key={`${pp.id}-${idx}`}
                          type="button"
                          onClick={() => selectProvince(pp.title)}
                          onMouseEnter={() => setHoverProvince(pp.id)}
                          onMouseLeave={() => setHoverProvince(null)}
                          className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors"
                          style={{
                            background: isSelected
                              ? 'rgba(var(--primary), 0.2)'
                              : isHover
                              ? 'rgba(var(--primary), 0.12)'
                              : 'transparent',
                            color: isSelected ? 'rgb(var(--primary))' : 'var(--text-90)',
                            borderBottom: '1px solid var(--border)',
                          }}
                        >
                          <MapPin className="w-3 h-3 flex-shrink-0" style={{ color: isSelected ? 'rgb(var(--primary))' : 'var(--text-50)' }} />
                          <span className="flex-1 truncate font-medium">{provZh}</span>
                        </button>
                      );
                    })
                  ) : (
                    <div
                      className="px-3 py-8 text-center text-xs"
                      style={{ color: 'var(--text-50)' }}
                    >
                      {loadingCountry ? t('locationLoading') : ''}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}