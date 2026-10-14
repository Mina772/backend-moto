import type { Brand, Category, MotorcycleModel, Product } from '@moto/shared';
import { buildInternalBarcode } from '@moto/shared';
import { rng, daysAgo, pad } from './rng.js';

export const brands: Brand[] = [
  { id: 'brand-1', name: { ar: 'هوندا', en: 'Honda' }, country: { ar: 'اليابان', en: 'Japan' } },
  { id: 'brand-2', name: { ar: 'سوزوكي', en: 'Suzuki' }, country: { ar: 'اليابان', en: 'Japan' } },
  { id: 'brand-3', name: { ar: 'ياماها', en: 'Yamaha' }, country: { ar: 'اليابان', en: 'Japan' } },
  { id: 'brand-4', name: { ar: 'باجاج', en: 'Bajaj' }, country: { ar: 'الهند', en: 'India' } },
  { id: 'brand-5', name: { ar: 'NGK', en: 'NGK' }, country: { ar: 'اليابان', en: 'Japan' } },
  { id: 'brand-6', name: { ar: 'DID', en: 'DID' }, country: { ar: 'اليابان', en: 'Japan' } },
  { id: 'brand-7', name: { ar: 'موتول', en: 'Motul' }, country: { ar: 'فرنسا', en: 'France' } },
  { id: 'brand-8', name: { ar: 'دايون', en: 'Dayun' }, country: { ar: 'الصين', en: 'China' } },
  { id: 'brand-9', name: { ar: 'هالاوي', en: 'Halawa' }, country: { ar: 'مصر', en: 'Egypt' } },
  { id: 'brand-10', name: { ar: 'يوسا', en: 'Yuasa' }, country: { ar: 'اليابان', en: 'Japan' } },
];

/** Root departments: the top level of the catalogue tree. */
const departments: { id: string; ar: string; en: string; sizes: number[] }[] = [
  { id: 'cat-dep-2w', ar: 'موتر 2 عجلة', en: '2-Wheel Motorcycles', sizes: [125, 150, 200] },
  { id: 'cat-dep-3w', ar: 'موتر 3 عجلة', en: '3-Wheel Motorcycles', sizes: [150, 200] },
  { id: 'cat-dep-sport', ar: 'موتر رياضي', en: 'Sport Motorcycles', sizes: [150, 200, 250] },
  { id: 'cat-dep-accessories', ar: 'الزينة والإكسسوارات', en: 'Accessories & Decoration', sizes: [] },
];

const systems: { id: string; ar: string; en: string }[] = [
  { id: 'cat-1', ar: 'المحرك', en: 'Engine' },
  { id: 'cat-2', ar: 'الفرامل', en: 'Brakes' },
  { id: 'cat-3', ar: 'نقل الحركة', en: 'Transmission' },
  { id: 'cat-4', ar: 'الكهرباء', en: 'Electrical' },
  { id: 'cat-5', ar: 'الهيكل والبودي', en: 'Body & Frame' },
  { id: 'cat-6', ar: 'الإطارات والجنوط', en: 'Tires & Wheels' },
  { id: 'cat-7', ar: 'الزيوت والسوائل', en: 'Oils & Fluids' },
  { id: 'cat-8', ar: 'نظام التعليق', en: 'Suspension' },
  { id: 'cat-9', ar: 'نظام الوقود', en: 'Fuel System' },
  { id: 'cat-10', ar: 'الفلاتر', en: 'Filters' },
  { id: 'cat-11', ar: 'الإكسسوارات', en: 'Accessories' },
];

/** Department → engine size → part system, so every engine size owns its own products. */
export const categories: Category[] = [
  ...departments.map<Category>((d, i) => ({ id: d.id, name: { ar: d.ar, en: d.en }, parentId: null, ancestors: [], sortOrder: i, isActive: true })),
  ...departments.flatMap<Category>((d) =>
    d.sizes.flatMap<Category>((cc, j) => [
      { id: `${d.id}-${cc}`, name: { ar: `${cc}cc`, en: `${cc}cc` }, parentId: d.id, ancestors: [d.id], sortOrder: j, isActive: true },
      ...systems.map<Category>((s, k) => ({
        id: `${d.id}-${cc}-${s.id}`,
        name: { ar: s.ar, en: s.en },
        parentId: `${d.id}-${cc}`,
        ancestors: [d.id, `${d.id}-${cc}`],
        sortOrder: k,
        isActive: true,
      })),
    ]),
  ),
  // Accessories has no engine sizes; its systems hang directly off the department.
  ...systems.map<Category>((s, i) => ({ id: `cat-dep-accessories-${s.id}`, name: { ar: s.ar, en: s.en }, parentId: 'cat-dep-accessories', ancestors: ['cat-dep-accessories'], sortOrder: i, isActive: true })),
];



export const motorcycleModels: MotorcycleModel[] = [
  { id: 'mdl-1', code: 'GN125', name: { ar: 'سوزوكي GN125', en: 'Suzuki GN125' }, manufacturer: 'Suzuki', engineCc: 125, years: '1982-2024' },
  { id: 'mdl-2', code: 'CG125', name: { ar: 'هوندا CG125', en: 'Honda CG125' }, manufacturer: 'Honda', engineCc: 125, years: '1976-2024' },
  { id: 'mdl-3', code: 'CG150', name: { ar: 'هوندا CG150', en: 'Honda CG150' }, manufacturer: 'Honda', engineCc: 150, years: '2004-2024' },
  { id: 'mdl-4', code: 'CG200', name: { ar: 'هوندا CG200', en: 'Honda CG200' }, manufacturer: 'Honda', engineCc: 200, years: '2010-2024' },
  { id: 'mdl-5', code: 'YBR125', name: { ar: 'ياماها YBR125', en: 'Yamaha YBR125' }, manufacturer: 'Yamaha', engineCc: 125, years: '2005-2024' },
  { id: 'mdl-6', code: 'BOXER150', name: { ar: 'باجاج بوكسر 150', en: 'Bajaj Boxer 150' }, manufacturer: 'Bajaj', engineCc: 150, years: '2012-2024' },
  { id: 'mdl-7', code: 'DAYUN150', name: { ar: 'دايون 150', en: 'Dayun 150' }, manufacturer: 'Dayun', engineCc: 150, years: '2015-2024' },
  { id: 'mdl-8', code: 'HALAWA125', name: { ar: 'هالاوي 125', en: 'Halawa 125' }, manufacturer: 'Halawa', engineCc: 125, years: '2016-2024' },
];

type Seed = {
  ar: string;
  en: string;
  cat: string;
  brand: string;
  cost: number;
  retail: number;
  wholesale: number;
  minStock: number;
  models: string[];
  partPrefix: string;
  unit?: 'piece' | 'set' | 'liter';
};

const seeds: Seed[] = [
  { ar: 'بوجيه NGK CR7HSA', en: 'Spark Plug NGK CR7HSA', cat: 'cat-4', brand: 'brand-5', cost: 35, retail: 60, wholesale: 48, minStock: 50, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-5', 'mdl-8'], partPrefix: 'NGK-CR7HSA' },
  { ar: 'بوجيه NGK D8EA', en: 'Spark Plug NGK D8EA', cat: 'cat-4', brand: 'brand-5', cost: 40, retail: 70, wholesale: 55, minStock: 40, models: ['mdl-4', 'mdl-6', 'mdl-7'], partPrefix: 'NGK-D8EA' },
  { ar: 'طقم جنزير وترس DID 428H', en: 'Chain & Sprocket Kit DID 428H', cat: 'cat-3', brand: 'brand-6', cost: 320, retail: 480, wholesale: 410, minStock: 15, models: ['mdl-2', 'mdl-3', 'mdl-5'], partPrefix: 'DID-428H-KIT', unit: 'set' },
  { ar: 'جنزير DID 428 × 118 وصلة', en: 'Chain DID 428 x 118L', cat: 'cat-3', brand: 'brand-6', cost: 180, retail: 270, wholesale: 230, minStock: 20, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-5', 'mdl-8'], partPrefix: 'DID-428-118' },
  { ar: 'تيل فرامل أمامي CG125', en: 'Front Brake Shoes CG125', cat: 'cat-2', brand: 'brand-1', cost: 45, retail: 85, wholesale: 70, minStock: 30, models: ['mdl-2', 'mdl-3', 'mdl-8'], partPrefix: 'HND-06430-KGA', unit: 'set' },
  { ar: 'تيل فرامل خلفي CG150', en: 'Rear Brake Shoes CG150', cat: 'cat-2', brand: 'brand-1', cost: 50, retail: 95, wholesale: 78, minStock: 30, models: ['mdl-3', 'mdl-4'], partPrefix: 'HND-06435-KGA', unit: 'set' },
  { ar: 'طقم تيل ديسك أمامي CG200', en: 'Front Disc Brake Pads CG200', cat: 'cat-2', brand: 'brand-1', cost: 70, retail: 130, wholesale: 105, minStock: 25, models: ['mdl-4', 'mdl-6'], partPrefix: 'HND-06455-KPP', unit: 'set' },
  { ar: 'ماستر فرامل ديسك علوي', en: 'Disc Brake Master Cylinder', cat: 'cat-2', brand: 'brand-8', cost: 150, retail: 250, wholesale: 210, minStock: 10, models: ['mdl-4', 'mdl-6', 'mdl-7'], partPrefix: 'DYN-45510' },
  { ar: 'فلتر هواء GN125', en: 'Air Filter GN125', cat: 'cat-10', brand: 'brand-2', cost: 30, retail: 55, wholesale: 45, minStock: 40, models: ['mdl-1'], partPrefix: 'SZK-13780-05300' },
  { ar: 'فلتر هواء CG125 / CG150', en: 'Air Filter CG125 / CG150', cat: 'cat-10', brand: 'brand-1', cost: 28, retail: 50, wholesale: 42, minStock: 40, models: ['mdl-2', 'mdl-3'], partPrefix: 'HND-17210-KGA' },
  { ar: 'فلتر زيت YBR125', en: 'Oil Filter YBR125', cat: 'cat-10', brand: 'brand-3', cost: 25, retail: 45, wholesale: 38, minStock: 40, models: ['mdl-5'], partPrefix: 'YMH-5VL-E3440' },
  { ar: 'زيت محرك موتول 3000 20W50 - 1 لتر', en: 'Motul 3000 20W50 Engine Oil - 1L', cat: 'cat-7', brand: 'brand-7', cost: 110, retail: 165, wholesale: 140, minStock: 60, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-4', 'mdl-5', 'mdl-6', 'mdl-7', 'mdl-8'], partPrefix: 'MTL-3000-20W50', unit: 'liter' },
  { ar: 'زيت محرك موتول 5100 10W40 - 1 لتر', en: 'Motul 5100 10W40 Engine Oil - 1L', cat: 'cat-7', brand: 'brand-7', cost: 180, retail: 260, wholesale: 225, minStock: 40, models: ['mdl-4', 'mdl-5', 'mdl-6'], partPrefix: 'MTL-5100-10W40', unit: 'liter' },
  { ar: 'طقم شنابر 56.5 مم CG125', en: 'Piston Ring Set 56.5mm CG125', cat: 'cat-1', brand: 'brand-1', cost: 60, retail: 110, wholesale: 90, minStock: 20, models: ['mdl-2', 'mdl-8'], partPrefix: 'HND-13011-KGA', unit: 'set' },
  { ar: 'طقم بستم كامل 62 مم CG150', en: 'Piston Kit 62mm CG150', cat: 'cat-1', brand: 'brand-1', cost: 220, retail: 350, wholesale: 300, minStock: 12, models: ['mdl-3'], partPrefix: 'HND-13101-KGA', unit: 'set' },
  { ar: 'سلندر كامل CG200', en: 'Cylinder Block Assembly CG200', cat: 'cat-1', brand: 'brand-8', cost: 480, retail: 720, wholesale: 630, minStock: 6, models: ['mdl-4'], partPrefix: 'DYN-12100-200' },
  { ar: 'طقم جوانات محرك كامل GN125', en: 'Complete Engine Gasket Set GN125', cat: 'cat-1', brand: 'brand-2', cost: 95, retail: 160, wholesale: 135, minStock: 15, models: ['mdl-1'], partPrefix: 'SZK-11400-05810', unit: 'set' },
  { ar: 'جنزير كامة CG125 (82 وصلة)', en: 'Cam Chain CG125 (82L)', cat: 'cat-1', brand: 'brand-6', cost: 55, retail: 95, wholesale: 80, minStock: 20, models: ['mdl-2', 'mdl-3'], partPrefix: 'DID-25H-82' },
  { ar: 'كاربراتير كامل CG125 PZ26', en: 'Carburetor Assembly CG125 PZ26', cat: 'cat-9', brand: 'brand-8', cost: 280, retail: 420, wholesale: 360, minStock: 8, models: ['mdl-2', 'mdl-8'], partPrefix: 'DYN-PZ26' },
  { ar: 'كاربراتير كامل GN125 BS26', en: 'Carburetor Assembly GN125 BS26', cat: 'cat-9', brand: 'brand-2', cost: 650, retail: 950, wholesale: 820, minStock: 5, models: ['mdl-1'], partPrefix: 'SZK-13200-05302' },
  { ar: 'حنفية بنزين GN125', en: 'Fuel Petcock GN125', cat: 'cat-9', brand: 'brand-2', cost: 70, retail: 120, wholesale: 100, minStock: 15, models: ['mdl-1'], partPrefix: 'SZK-44300-05300' },
  { ar: 'بطارية يوسا YTX7L-BS', en: 'Battery Yuasa YTX7L-BS', cat: 'cat-4', brand: 'brand-10', cost: 450, retail: 650, wholesale: 570, minStock: 10, models: ['mdl-3', 'mdl-4', 'mdl-5', 'mdl-6'], partPrefix: 'YUA-YTX7L-BS' },
  { ar: 'بطارية يوسا YB5L-B', en: 'Battery Yuasa YB5L-B', cat: 'cat-4', brand: 'brand-10', cost: 280, retail: 420, wholesale: 360, minStock: 12, models: ['mdl-1', 'mdl-2', 'mdl-8'], partPrefix: 'YUA-YB5L-B' },
  { ar: 'موتور مارش CG150', en: 'Starter Motor CG150', cat: 'cat-4', brand: 'brand-8', cost: 350, retail: 520, wholesale: 450, minStock: 6, models: ['mdl-3', 'mdl-4'], partPrefix: 'DYN-31200-150' },
  { ar: 'بوبينة إشعال CDI عالمية', en: 'Ignition Coil CDI Universal', cat: 'cat-4', brand: 'brand-8', cost: 60, retail: 110, wholesale: 90, minStock: 20, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-5', 'mdl-7', 'mdl-8'], partPrefix: 'DYN-30500-UNI' },
  { ar: 'وحدة CDI CG125 (6 أطراف)', en: 'CDI Unit CG125 (6-pin)', cat: 'cat-4', brand: 'brand-8', cost: 85, retail: 150, wholesale: 125, minStock: 15, models: ['mdl-2', 'mdl-3', 'mdl-8'], partPrefix: 'DYN-30410-6P' },
  { ar: 'منظم شحن (ريجيوليتر) 5 أطراف', en: 'Voltage Regulator Rectifier 5-pin', cat: 'cat-4', brand: 'brand-8', cost: 75, retail: 130, wholesale: 110, minStock: 15, models: ['mdl-2', 'mdl-3', 'mdl-4', 'mdl-6'], partPrefix: 'DYN-31600-5P' },
  { ar: 'لمبة أمامية H4 12V 35/35W', en: 'Headlight Bulb H4 12V 35/35W', cat: 'cat-4', brand: 'brand-8', cost: 15, retail: 30, wholesale: 24, minStock: 60, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-4', 'mdl-5', 'mdl-6', 'mdl-7', 'mdl-8'], partPrefix: 'DYN-H4-3535' },
  { ar: 'إطار أمامي 2.75-18', en: 'Front Tire 2.75-18', cat: 'cat-6', brand: 'brand-9', cost: 320, retail: 450, wholesale: 400, minStock: 10, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-5', 'mdl-8'], partPrefix: 'HLW-275-18' },
  { ar: 'إطار خلفي 3.00-18', en: 'Rear Tire 3.00-18', cat: 'cat-6', brand: 'brand-9', cost: 380, retail: 530, wholesale: 470, minStock: 10, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-5', 'mdl-8'], partPrefix: 'HLW-300-18' },
  { ar: 'إطار خلفي 3.25-18', en: 'Rear Tire 3.25-18', cat: 'cat-6', brand: 'brand-9', cost: 420, retail: 590, wholesale: 520, minStock: 8, models: ['mdl-4', 'mdl-6'], partPrefix: 'HLW-325-18' },
  { ar: 'شامبريل 3.00-18', en: 'Inner Tube 3.00-18', cat: 'cat-6', brand: 'brand-9', cost: 40, retail: 70, wholesale: 58, minStock: 40, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-5'], partPrefix: 'HLW-TUBE-300-18' },
  { ar: 'مساعد خلفي زوج CG125', en: 'Rear Shock Absorber Pair CG125', cat: 'cat-8', brand: 'brand-8', cost: 220, retail: 350, wholesale: 300, minStock: 8, models: ['mdl-2', 'mdl-3', 'mdl-8'], partPrefix: 'DYN-52400-125', unit: 'set' },
  { ar: 'مساعد خلفي زوج CG200 غاز', en: 'Rear Gas Shock Absorber Pair CG200', cat: 'cat-8', brand: 'brand-8', cost: 380, retail: 580, wholesale: 500, minStock: 6, models: ['mdl-4', 'mdl-6'], partPrefix: 'DYN-52400-200G', unit: 'set' },
  { ar: 'طقم أويل سيل شوكة أمامية 30×42', en: 'Front Fork Oil Seal Set 30x42', cat: 'cat-8', brand: 'brand-1', cost: 25, retail: 50, wholesale: 40, minStock: 30, models: ['mdl-2', 'mdl-3', 'mdl-5'], partPrefix: 'HND-91255-KGA', unit: 'set' },
  { ar: 'دبرياج كامل (طقم أقراص) CG125', en: 'Clutch Plate Set CG125', cat: 'cat-3', brand: 'brand-1', cost: 90, retail: 160, wholesale: 135, minStock: 15, models: ['mdl-2', 'mdl-3', 'mdl-8'], partPrefix: 'HND-22201-KGA', unit: 'set' },
  { ar: 'سلك دبرياج CG125', en: 'Clutch Cable CG125', cat: 'cat-3', brand: 'brand-8', cost: 20, retail: 40, wholesale: 32, minStock: 40, models: ['mdl-2', 'mdl-3', 'mdl-8'], partPrefix: 'DYN-22870-125' },
  { ar: 'سلك بنزين (دواسة) GN125', en: 'Throttle Cable GN125', cat: 'cat-9', brand: 'brand-2', cost: 22, retail: 45, wholesale: 36, minStock: 40, models: ['mdl-1'], partPrefix: 'SZK-58300-05300' },
  { ar: 'سلك عداد سرعة عالمي', en: 'Speedometer Cable Universal', cat: 'cat-4', brand: 'brand-8', cost: 18, retail: 35, wholesale: 28, minStock: 40, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-5', 'mdl-8'], partPrefix: 'DYN-44830-UNI' },
  { ar: 'طقم مرايات كروم عالمي', en: 'Chrome Mirror Set Universal', cat: 'cat-11', brand: 'brand-8', cost: 45, retail: 85, wholesale: 70, minStock: 30, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-4', 'mdl-5', 'mdl-6', 'mdl-7', 'mdl-8'], partPrefix: 'DYN-88110-CHR', unit: 'set' },
  { ar: 'كرسي (سرج) CG125 أسود', en: 'Seat CG125 Black', cat: 'cat-5', brand: 'brand-8', cost: 180, retail: 290, wholesale: 245, minStock: 6, models: ['mdl-2', 'mdl-8'], partPrefix: 'DYN-77200-125' },
  { ar: 'تانك بنزين GN125 أسود', en: 'Fuel Tank GN125 Black', cat: 'cat-5', brand: 'brand-8', cost: 550, retail: 850, wholesale: 740, minStock: 3, models: ['mdl-1'], partPrefix: 'DYN-44100-GN' },
  { ar: 'رفرف أمامي CG150', en: 'Front Fender CG150', cat: 'cat-5', brand: 'brand-8', cost: 85, retail: 150, wholesale: 125, minStock: 8, models: ['mdl-3', 'mdl-4'], partPrefix: 'DYN-61100-150' },
  { ar: 'شكمان كامل CG125', en: 'Exhaust Muffler CG125', cat: 'cat-1', brand: 'brand-8', cost: 320, retail: 500, wholesale: 430, minStock: 5, models: ['mdl-2', 'mdl-8'], partPrefix: 'DYN-18300-125' },
  { ar: 'شكمان كامل Boxer 150', en: 'Exhaust Muffler Boxer 150', cat: 'cat-1', brand: 'brand-4', cost: 420, retail: 650, wholesale: 560, minStock: 4, models: ['mdl-6'], partPrefix: 'BJJ-18300-BX' },
  { ar: 'ترس خلفي 428-41T', en: 'Rear Sprocket 428-41T', cat: 'cat-3', brand: 'brand-6', cost: 65, retail: 110, wholesale: 92, minStock: 20, models: ['mdl-2', 'mdl-3', 'mdl-5'], partPrefix: 'DID-RS-428-41' },
  { ar: 'ترس أمامي 428-15T', en: 'Front Sprocket 428-15T', cat: 'cat-3', brand: 'brand-6', cost: 25, retail: 50, wholesale: 40, minStock: 30, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-5'], partPrefix: 'DID-FS-428-15' },
  { ar: 'طقم رولمان بلي عجلة أمامية 6301', en: 'Front Wheel Bearing Set 6301', cat: 'cat-6', brand: 'brand-1', cost: 35, retail: 65, wholesale: 54, minStock: 25, models: ['mdl-2', 'mdl-3', 'mdl-5'], partPrefix: 'HND-91051-6301', unit: 'set' },
  { ar: 'قفل كونتاكت كامل مع مفاتيح CG125', en: 'Ignition Switch Lock Set CG125', cat: 'cat-4', brand: 'brand-8', cost: 70, retail: 125, wholesale: 105, minStock: 12, models: ['mdl-2', 'mdl-3', 'mdl-8'], partPrefix: 'DYN-35100-125', unit: 'set' },
  { ar: 'عداد سرعة كامل YBR125', en: 'Speedometer Assembly YBR125', cat: 'cat-4', brand: 'brand-3', cost: 380, retail: 580, wholesale: 500, minStock: 4, models: ['mdl-5'], partPrefix: 'YMH-5VL-H3510' },
  { ar: 'كشاف أمامي كامل CG125', en: 'Headlight Assembly CG125', cat: 'cat-4', brand: 'brand-8', cost: 150, retail: 250, wholesale: 210, minStock: 8, models: ['mdl-2', 'mdl-8'], partPrefix: 'DYN-33100-125' },
  { ar: 'طقم فوانيس إشارة (4 قطع)', en: 'Turn Signal Set (4 pcs)', cat: 'cat-4', brand: 'brand-8', cost: 60, retail: 110, wholesale: 90, minStock: 20, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-5', 'mdl-8'], partPrefix: 'DYN-33400-4P', unit: 'set' },
  { ar: 'كلاكس 12 فولت', en: 'Horn 12V', cat: 'cat-4', brand: 'brand-8', cost: 25, retail: 50, wholesale: 40, minStock: 30, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-4', 'mdl-5', 'mdl-6', 'mdl-7', 'mdl-8'], partPrefix: 'DYN-38110-12V' },
  { ar: 'دواسة فرامل خلفي CG125', en: 'Rear Brake Pedal CG125', cat: 'cat-2', brand: 'brand-8', cost: 55, retail: 95, wholesale: 80, minStock: 10, models: ['mdl-2', 'mdl-3', 'mdl-8'], partPrefix: 'DYN-46500-125' },
  { ar: 'طقم جوانات رأس سلندر CG150', en: 'Cylinder Head Gasket Set CG150', cat: 'cat-1', brand: 'brand-1', cost: 40, retail: 75, wholesale: 62, minStock: 20, models: ['mdl-3'], partPrefix: 'HND-12251-KGA', unit: 'set' },
  { ar: 'صبابات (بلوف) طقم CG125', en: 'Valve Set CG125', cat: 'cat-1', brand: 'brand-1', cost: 80, retail: 140, wholesale: 118, minStock: 12, models: ['mdl-2', 'mdl-8'], partPrefix: 'HND-14711-KGA', unit: 'set' },
  { ar: 'كرنك كامل CG125', en: 'Crankshaft Assembly CG125', cat: 'cat-1', brand: 'brand-8', cost: 650, retail: 950, wholesale: 830, minStock: 3, models: ['mdl-2', 'mdl-8'], partPrefix: 'DYN-13000-125' },
  { ar: 'طرمبة زيت CG150', en: 'Oil Pump CG150', cat: 'cat-1', brand: 'brand-1', cost: 110, retail: 185, wholesale: 155, minStock: 8, models: ['mdl-3', 'mdl-4'], partPrefix: 'HND-15100-KGA' },
  { ar: 'مقبض يد (فردة) مطاط', en: 'Handlebar Grips Pair', cat: 'cat-11', brand: 'brand-8', cost: 15, retail: 30, wholesale: 24, minStock: 50, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-4', 'mdl-5', 'mdl-6', 'mdl-7', 'mdl-8'], partPrefix: 'DYN-53165-GRP', unit: 'set' },
  { ar: 'ستاند جانبي CG125', en: 'Side Stand CG125', cat: 'cat-5', brand: 'brand-8', cost: 60, retail: 105, wholesale: 88, minStock: 10, models: ['mdl-2', 'mdl-3', 'mdl-8'], partPrefix: 'DYN-50530-125' },
  { ar: 'ستاند وسط CG150', en: 'Center Stand CG150', cat: 'cat-5', brand: 'brand-8', cost: 120, retail: 200, wholesale: 170, minStock: 6, models: ['mdl-3', 'mdl-4'], partPrefix: 'DYN-50500-150' },
  { ar: 'سائل فرامل DOT4 - 250 مل', en: 'Brake Fluid DOT4 - 250ml', cat: 'cat-7', brand: 'brand-7', cost: 45, retail: 75, wholesale: 62, minStock: 30, models: ['mdl-4', 'mdl-6', 'mdl-7'], partPrefix: 'MTL-DOT4-250' },
  { ar: 'شحم جنزير موتول C2 - 400 مل', en: 'Motul C2 Chain Lube - 400ml', cat: 'cat-7', brand: 'brand-7', cost: 120, retail: 180, wholesale: 155, minStock: 20, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-4', 'mdl-5', 'mdl-6', 'mdl-7', 'mdl-8'], partPrefix: 'MTL-C2-400' },
  { ar: 'فلتر بنزين شفاف عالمي', en: 'Inline Fuel Filter Universal', cat: 'cat-10', brand: 'brand-8', cost: 8, retail: 20, wholesale: 15, minStock: 100, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-4', 'mdl-5', 'mdl-6', 'mdl-7', 'mdl-8'], partPrefix: 'DYN-16900-UNI' },
  { ar: 'ديسك فرامل أمامي 240 مم Boxer', en: 'Front Brake Disc 240mm Boxer', cat: 'cat-2', brand: 'brand-4', cost: 180, retail: 290, wholesale: 245, minStock: 6, models: ['mdl-6'], partPrefix: 'BJJ-45251-240' },
  { ar: 'طقم شنابر 57 مم Boxer 150', en: 'Piston Ring Set 57mm Boxer 150', cat: 'cat-1', brand: 'brand-4', cost: 70, retail: 125, wholesale: 105, minStock: 15, models: ['mdl-6'], partPrefix: 'BJJ-13011-57', unit: 'set' },
  { ar: 'فلتر هواء Boxer 150', en: 'Air Filter Boxer 150', cat: 'cat-10', brand: 'brand-4', cost: 35, retail: 65, wholesale: 52, minStock: 30, models: ['mdl-6'], partPrefix: 'BJJ-17210-BX' },
  { ar: 'طقم إصلاح كاربراتير CG125', en: 'Carburetor Repair Kit CG125', cat: 'cat-9', brand: 'brand-8', cost: 30, retail: 60, wholesale: 48, minStock: 25, models: ['mdl-2', 'mdl-3', 'mdl-8'], partPrefix: 'DYN-16010-125', unit: 'set' },
  { ar: 'طقم جنوط (أمامي + خلفي) 18 بوصة', en: 'Wheel Rim Set 18" (F+R)', cat: 'cat-6', brand: 'brand-8', cost: 650, retail: 980, wholesale: 850, minStock: 3, models: ['mdl-2', 'mdl-3', 'mdl-8'], partPrefix: 'DYN-44701-18', unit: 'set' },
  { ar: 'طقم سلك (شعاع) عجلة 36 قطعة', en: 'Wheel Spoke Set 36 pcs', cat: 'cat-6', brand: 'brand-8', cost: 55, retail: 95, wholesale: 80, minStock: 15, models: ['mdl-1', 'mdl-2', 'mdl-3', 'mdl-5', 'mdl-8'], partPrefix: 'DYN-44600-36', unit: 'set' },
];

const unitNames = {
  piece: { ar: 'قطعة', en: 'Piece' },
  set: { ar: 'طقم', en: 'Set' },
  liter: { ar: 'لتر', en: 'Liter' },
};

const supplierIds = ['sup-1', 'sup-2', 'sup-3', 'sup-4', 'sup-5', 'sup-6'];

const sizeByModel = new Map(motorcycleModels.map((m) => [m.id, m.engineCc]));
const motorDepartments = departments.filter((d) => d.sizes.length);

/** Files a seeded part under the department → engine-size → system leaf implied by the models it fits. */
function leafCategoryFor(seed: { cat: string; models: string[] }, index: number): string {
  if (seed.cat === 'cat-11') return `cat-dep-accessories-${seed.cat}`;
  const sizes = seed.models.map((id) => sizeByModel.get(id)).filter((cc): cc is number => cc !== undefined);
  const candidates = motorDepartments.filter((d) => d.sizes.some((cc) => sizes.includes(cc)));
  const dep = (candidates.length ? candidates[index % candidates.length]! : motorDepartments[0]!);
  const size = dep.sizes.find((cc) => sizes.includes(cc)) ?? dep.sizes[0]!;
  return `${dep.id}-${size}-${seed.cat}`;
}

export const products: Product[] = seeds.map((s, i) => {
  const n = i + 1;
  const ean = `622${pad(rng.int(100000000, 999999999), 9)}`;
  const checkDigit = rng.int(0, 9);
  return {
    id: `prod-${n}`,
    name: { ar: s.ar, en: s.en },
    legacyBarcode: `${ean}${checkDigit}`,
    internalBarcode: buildInternalBarcode('MP', n, 8),
    sku: `SKU-${s.cat.replace('cat-', 'C')}-${pad(n, 4)}`,
    partNumber: s.partPrefix,
    brandId: s.brand,
    categoryId: leafCategoryFor(s, i),
    supplierId: supplierIds[i % supplierIds.length]!,
    purchasePrice: s.cost,
    lastPurchaseCost: Math.round(s.cost * (1 + (rng.next() - 0.4) * 0.08)),
    prices: { retail1: s.retail, retail2: Math.round(s.retail * 0.95), wholesale: s.wholesale },
    minStock: s.minStock,
    unit: unitNames[s.unit ?? 'piece'],
    compatibleModelIds: s.models,
    alternativeProductIds: [],
    isActive: i !== 41,
    createdAt: daysAgo(rng.int(60, 700)),
    updatedAt: daysAgo(rng.int(0, 59)),
  };
});

// Alternatives: link obvious pairs
const altPairs: [number, number][] = [
  [1, 2], [5, 6], [9, 10], [12, 13], [22, 23], [29, 30], [33, 34], [46, 47], [10, 66],
];
for (const [a, b] of altPairs) {
  const pa = products[a - 1];
  const pb = products[b - 1];
  if (pa && pb) {
    pa.alternativeProductIds.push(pb.id);
    pb.alternativeProductIds.push(pa.id);
  }
}
