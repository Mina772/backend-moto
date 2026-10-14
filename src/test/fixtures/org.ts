import type { Branch, CashRegister, Customer, ExpenseCategory, Supplier, User, Warehouse } from '@moto/shared';
import { daysAgo, rng } from './rng.js';

export const branches: Branch[] = [
  { id: 'br-1', code: 'CAI', name: { ar: 'فرع القاهرة - العتبة', en: 'Cairo - Ataba' }, city: { ar: 'القاهرة', en: 'Cairo' }, address: { ar: 'شارع الجمهورية، العتبة', en: 'El Gomhoreya St., Ataba' }, phone: '0225912345', managerId: 'usr-2', isActive: true, posTerminals: 3, openedAt: '2018-03-01T00:00:00.000Z' },
  { id: 'br-2', code: 'GIZ', name: { ar: 'فرع الجيزة - فيصل', en: 'Giza - Faisal' }, city: { ar: 'الجيزة', en: 'Giza' }, address: { ar: 'شارع فيصل الرئيسي، محطة التعاون', en: 'Faisal Main St., El Taawon' }, phone: '0237712345', managerId: 'usr-3', isActive: true, posTerminals: 2, openedAt: '2020-06-15T00:00:00.000Z' },
  { id: 'br-3', code: 'ALX', name: { ar: 'فرع الإسكندرية - محرم بك', en: 'Alexandria - Moharam Bek' }, city: { ar: 'الإسكندرية', en: 'Alexandria' }, address: { ar: 'شارع محرم بك، أمام الكوبري', en: 'Moharam Bek St.' }, phone: '0334912345', managerId: 'usr-4', isActive: true, posTerminals: 2, openedAt: '2021-09-01T00:00:00.000Z' },
  { id: 'br-4', code: 'MNS', name: { ar: 'فرع المنصورة', en: 'Mansoura' }, city: { ar: 'المنصورة', en: 'Mansoura' }, address: { ar: 'شارع الجمهورية، المنصورة', en: 'El Gomhoreya St., Mansoura' }, phone: '0502312345', managerId: 'usr-5', isActive: true, posTerminals: 1, openedAt: '2023-02-01T00:00:00.000Z' },
  { id: 'br-5', code: 'TNT', name: { ar: 'فرع طنطا', en: 'Tanta' }, city: { ar: 'طنطا', en: 'Tanta' }, address: { ar: 'شارع البحر، طنطا', en: 'El Bahr St., Tanta' }, phone: '0403312345', managerId: 'usr-2', isActive: false, posTerminals: 1, openedAt: '2024-05-01T00:00:00.000Z' },
];

const mkWh = (id: string, code: string, ar: string, en: string, branchId: string, isMain: boolean, capacity: number, locs: number): Warehouse => ({
  id, code, name: { ar, en }, branchId, isActive: true, isMain, capacity,
  locations: Array.from({ length: locs }, (_, li) => ({
    id: `${id}-loc-${li + 1}`, code: `${String.fromCharCode(65 + li)}`, name: { ar: `منطقة ${String.fromCharCode(65 + li)}`, en: `Zone ${String.fromCharCode(65 + li)}` },
    shelves: Array.from({ length: 4 }, (_, si) => ({
      id: `${id}-loc-${li + 1}-sh-${si + 1}`, code: `${String.fromCharCode(65 + li)}${si + 1}`, locationId: `${id}-loc-${li + 1}`,
      bins: Array.from({ length: 6 }, (_, bi) => ({ id: `${id}-loc-${li + 1}-sh-${si + 1}-bin-${bi + 1}`, code: `${String.fromCharCode(65 + li)}${si + 1}-${bi + 1}`, shelfId: `${id}-loc-${li + 1}-sh-${si + 1}` })),
    })),
  })),
});

export const warehouses: Warehouse[] = [
  mkWh('wh-1', 'CAI-MAIN', 'مخزن القاهرة الرئيسي', 'Cairo Main Warehouse', 'br-1', true, 12000, 4),
  mkWh('wh-2', 'CAI-SHOP', 'مخزن محل العتبة', 'Ataba Shop Store', 'br-1', false, 2500, 2),
  mkWh('wh-3', 'GIZ-MAIN', 'مخزن الجيزة', 'Giza Warehouse', 'br-2', true, 6000, 3),
  mkWh('wh-4', 'ALX-MAIN', 'مخزن الإسكندرية', 'Alexandria Warehouse', 'br-3', true, 5000, 3),
  mkWh('wh-5', 'MNS-MAIN', 'مخزن المنصورة', 'Mansoura Warehouse', 'br-4', true, 3000, 2),
  mkWh('wh-6', 'TNT-MAIN', 'مخزن طنطا', 'Tanta Warehouse', 'br-5', true, 2000, 2),
];

const colors = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#be185d', '#4f46e5', '#059669', '#b45309'];

export const users: User[] = [
  { id: 'usr-1', username: 'admin', fullName: { ar: 'أحمد محمود الشريف', en: 'Ahmed Mahmoud El-Sherif' }, email: 'ahmed@motoparts.eg', phone: '01001234567', role: 'admin', branchId: 'br-1', status: 'active', avatarColor: colors[0], lastLogin: daysAgo(0, 8, 15), createdAt: '2018-03-01T00:00:00.000Z' },
  { id: 'usr-2', username: 'khaled.m', fullName: { ar: 'خالد مصطفى عبدالله', en: 'Khaled Mostafa Abdallah' }, email: 'khaled@motoparts.eg', phone: '01112345678', role: 'branch_manager', branchId: 'br-1', status: 'active', avatarColor: colors[1], lastLogin: daysAgo(0, 9, 2), createdAt: '2018-04-10T00:00:00.000Z' },
  { id: 'usr-3', username: 'mona.s', fullName: { ar: 'منى سعيد حسن', en: 'Mona Saeed Hassan' }, email: 'mona@motoparts.eg', phone: '01223456789', role: 'branch_manager', branchId: 'br-2', status: 'active', avatarColor: colors[2], lastLogin: daysAgo(0, 8, 45), createdAt: '2020-06-15T00:00:00.000Z' },
  { id: 'usr-4', username: 'tarek.a', fullName: { ar: 'طارق عادل إبراهيم', en: 'Tarek Adel Ibrahim' }, email: 'tarek@motoparts.eg', phone: '01034567890', role: 'branch_manager', branchId: 'br-3', status: 'active', avatarColor: colors[3], lastLogin: daysAgo(1, 18, 30), createdAt: '2021-09-01T00:00:00.000Z' },
  { id: 'usr-5', username: 'hossam.r', fullName: { ar: 'حسام رمضان فتحي', en: 'Hossam Ramadan Fathy' }, email: 'hossam@motoparts.eg', phone: '01145678901', role: 'branch_manager', branchId: 'br-4', status: 'active', avatarColor: colors[4], lastLogin: daysAgo(0, 10, 5), createdAt: '2023-02-01T00:00:00.000Z' },
  { id: 'usr-6', username: 'sara.k', fullName: { ar: 'سارة كمال يوسف', en: 'Sara Kamal Youssef' }, email: 'sara@motoparts.eg', phone: '01256789012', role: 'accountant', branchId: 'br-1', status: 'active', avatarColor: colors[5], lastLogin: daysAgo(0, 9, 30), createdAt: '2019-01-15T00:00:00.000Z' },
  { id: 'usr-7', username: 'cashier1', fullName: { ar: 'محمد علي حسين', en: 'Mohamed Ali Hussein' }, email: 'm.ali@motoparts.eg', phone: '01067890123', role: 'cashier', branchId: 'br-1', status: 'active', avatarColor: colors[6], lastLogin: daysAgo(0, 8, 0), createdAt: '2021-03-01T00:00:00.000Z' },
  { id: 'usr-8', username: 'cashier2', fullName: { ar: 'عمر سمير فؤاد', en: 'Omar Samir Fouad' }, email: 'omar@motoparts.eg', phone: '01178901234', role: 'cashier', branchId: 'br-1', status: 'active', avatarColor: colors[7], lastLogin: daysAgo(0, 14, 0), createdAt: '2022-07-01T00:00:00.000Z' },
  { id: 'usr-9', username: 'yousef.g', fullName: { ar: 'يوسف جمال سيد', en: 'Youssef Gamal Sayed' }, email: 'youssef@motoparts.eg', phone: '01289012345', role: 'cashier', branchId: 'br-2', status: 'active', avatarColor: colors[8], lastLogin: daysAgo(0, 8, 20), createdAt: '2022-01-10T00:00:00.000Z' },
  { id: 'usr-10', username: 'mahmoud.e', fullName: { ar: 'محمود عصام رشاد', en: 'Mahmoud Essam Rashad' }, email: 'mahmoud@motoparts.eg', phone: '01090123456', role: 'cashier', branchId: 'br-3', status: 'active', avatarColor: colors[9], lastLogin: daysAgo(0, 9, 0), createdAt: '2022-10-01T00:00:00.000Z' },
  { id: 'usr-11', username: 'nour.h', fullName: { ar: 'نور هشام عبدالرحمن', en: 'Nour Hesham Abdelrahman' }, email: 'nour@motoparts.eg', phone: '01101234567', role: 'sales', branchId: 'br-1', status: 'active', avatarColor: colors[0], lastLogin: daysAgo(0, 10, 10), createdAt: '2023-05-01T00:00:00.000Z' },
  { id: 'usr-12', username: 'ali.w', fullName: { ar: 'علي وائل محمد', en: 'Ali Wael Mohamed' }, email: 'ali.w@motoparts.eg', phone: '01212345678', role: 'sales', branchId: 'br-2', status: 'active', avatarColor: colors[1], lastLogin: daysAgo(2, 11, 0), createdAt: '2023-08-01T00:00:00.000Z' },
  { id: 'usr-13', username: 'warehouse1', fullName: { ar: 'سيد عبدالعزيز محمود', en: 'Sayed Abdelaziz Mahmoud' }, email: 'sayed@motoparts.eg', phone: '01023456789', role: 'warehouse', branchId: 'br-1', status: 'active', avatarColor: colors[2], lastLogin: daysAgo(0, 7, 45), createdAt: '2019-06-01T00:00:00.000Z' },
  { id: 'usr-14', username: 'ibrahim.f', fullName: { ar: 'إبراهيم فاروق صالح', en: 'Ibrahim Farouk Saleh' }, email: 'ibrahim@motoparts.eg', phone: '01134567890', role: 'warehouse', branchId: 'br-3', status: 'active', avatarColor: colors[3], lastLogin: daysAgo(1, 8, 0), createdAt: '2022-02-01T00:00:00.000Z' },
  { id: 'usr-15', username: 'hany.m', fullName: { ar: 'هاني مجدي عطية', en: 'Hany Magdy Attia' }, email: 'hany@motoparts.eg', phone: '01245678901', role: 'cashier', branchId: 'br-4', status: 'inactive', avatarColor: colors[4], lastLogin: daysAgo(45, 16, 0), createdAt: '2023-03-01T00:00:00.000Z' },
  { id: 'usr-16', username: 'rania.a', fullName: { ar: 'رانيا أشرف لطفي', en: 'Rania Ashraf Lotfy' }, email: 'rania@motoparts.eg', phone: '01056789012', role: 'sales', branchId: 'br-3', status: 'suspended', avatarColor: colors[5], lastLogin: daysAgo(12, 13, 0), createdAt: '2024-01-15T00:00:00.000Z' },
];

export const suppliers: Supplier[] = [
  { id: 'sup-1', code: 'SUP-001', name: { ar: 'شركة النيل لاستيراد قطع الغيار', en: 'Nile Spare Parts Import Co.' }, contactPerson: { ar: 'م. حسن عبدالفتاح', en: 'Eng. Hassan Abdelfattah' }, phone: '0224567890', email: 'sales@nileparts.com', address: { ar: 'المنطقة الصناعية، العبور', en: 'Industrial Zone, Obour' }, balance: 128450, paymentTermsDays: 30, isActive: true, createdAt: '2018-03-15T00:00:00.000Z' },
  { id: 'sup-2', code: 'SUP-002', name: { ar: 'الوكيل المصري لهوندا', en: 'Egyptian Honda Agent' }, contactPerson: { ar: 'أ. محمد الدسوقي', en: 'Mr. Mohamed El-Desouky' }, phone: '0233456789', email: 'parts@honda-eg.com', address: { ar: 'طريق مصر إسكندرية الصحراوي', en: 'Cairo-Alex Desert Road' }, balance: 86200, paymentTermsDays: 45, isActive: true, createdAt: '2018-05-01T00:00:00.000Z' },
  { id: 'sup-3', code: 'SUP-003', name: { ar: 'مؤسسة الأمل للتجارة', en: 'Al-Amal Trading Est.' }, contactPerson: { ar: 'الحاج سمير عوض', en: 'Hajj Samir Awad' }, phone: '0225678901', email: 'alamal.trade@gmail.com', address: { ar: 'سوق الأزهر، القاهرة', en: 'Al-Azhar Market, Cairo' }, balance: 0, paymentTermsDays: 15, isActive: true, createdAt: '2019-02-01T00:00:00.000Z' },
  { id: 'sup-4', code: 'SUP-004', name: { ar: 'شركة جينج شنغ للتوريدات', en: 'Jing Sheng Supplies Co.' }, contactPerson: { ar: 'مستر وانج', en: 'Mr. Wang' }, phone: '01099887766', email: 'wang@jingsheng.cn', address: { ar: 'جوانجزو، الصين', en: 'Guangzhou, China' }, balance: 215000, paymentTermsDays: 60, isActive: true, createdAt: '2020-01-10T00:00:00.000Z' },
  { id: 'sup-5', code: 'SUP-005', name: { ar: 'موتول مصر للزيوت', en: 'Motul Egypt Lubricants' }, contactPerson: { ar: 'أ. أمير حلمي', en: 'Mr. Amir Helmy' }, phone: '0226789012', email: 'orders@motul-eg.com', address: { ar: 'مدينة نصر، القاهرة', en: 'Nasr City, Cairo' }, balance: 34800, paymentTermsDays: 30, isActive: true, createdAt: '2020-08-01T00:00:00.000Z' },
  { id: 'sup-6', code: 'SUP-006', name: { ar: 'مصنع هالاوي للإطارات', en: 'Halawa Tires Factory' }, contactPerson: { ar: 'م. أيمن هلال', en: 'Eng. Ayman Helal' }, phone: '0553456789', email: 'sales@halawatires.com', address: { ar: 'العاشر من رمضان', en: '10th of Ramadan City' }, balance: 52300, paymentTermsDays: 30, isActive: true, createdAt: '2021-03-01T00:00:00.000Z' },
  { id: 'sup-7', code: 'SUP-007', name: { ar: 'مؤسسة البركة لقطع الغيار', en: 'Al-Baraka Spare Parts' }, contactPerson: { ar: 'أ. رضا سليم', en: 'Mr. Reda Selim' }, phone: '0334567890', email: '', address: { ar: 'الإسكندرية، كرموز', en: 'Karmouz, Alexandria' }, balance: 0, paymentTermsDays: 0, isActive: false, createdAt: '2019-11-01T00:00:00.000Z' },
];

const custSeeds: { ar: string; en: string; type: Customer['type']; limit: number; balance: number; branch: string; addr: [string, string] }[] = [
  { ar: 'ورشة الحاج رمضان', en: "Hajj Ramadan Workshop", type: 'workshop', limit: 30000, balance: 18750, branch: 'br-1', addr: ['شارع بورسعيد، القاهرة', 'Port Said St., Cairo'] },
  { ar: 'محمد عبدالرحمن (موزع فيصل)', en: 'Mohamed Abdelrahman (Faisal Dealer)', type: 'wholesale', limit: 80000, balance: 64200, branch: 'br-2', addr: ['فيصل، الجيزة', 'Faisal, Giza'] },
  { ar: 'مركز خدمة السرعة', en: 'Speed Service Center', type: 'workshop', limit: 25000, balance: 9800, branch: 'br-1', addr: ['شبرا، القاهرة', 'Shubra, Cairo'] },
  { ar: 'أحمد سيد (عميل تجزئة)', en: 'Ahmed Sayed', type: 'retail', limit: 0, balance: 0, branch: 'br-1', addr: ['المرج، القاهرة', 'El Marg, Cairo'] },
  { ar: 'شركة توصيل سريع للدليفري', en: 'Fast Delivery Co.', type: 'wholesale', limit: 50000, balance: 42100, branch: 'br-1', addr: ['مدينة نصر', 'Nasr City'] },
  { ar: 'ورشة أبو علي', en: 'Abu Ali Workshop', type: 'workshop', limit: 15000, balance: 15900, branch: 'br-3', addr: ['العجمي، الإسكندرية', 'Agami, Alexandria'] },
  { ar: 'محل الصفا لقطع الغيار', en: 'Al-Safa Parts Shop', type: 'wholesale', limit: 60000, balance: 28400, branch: 'br-3', addr: ['محرم بك', 'Moharam Bek'] },
  { ar: 'كريم مجدي', en: 'Karim Magdy', type: 'retail', limit: 2000, balance: 450, branch: 'br-2', addr: ['الهرم', 'Haram'] },
  { ar: 'ورشة النور للموتوسيكلات', en: 'Al-Nour Motorcycle Workshop', type: 'workshop', limit: 20000, balance: 6300, branch: 'br-4', addr: ['طلخا، المنصورة', 'Talkha, Mansoura'] },
  { ar: 'مصطفى حسين (تاجر)', en: 'Mostafa Hussein (Trader)', type: 'wholesale', limit: 40000, balance: 0, branch: 'br-4', addr: ['المنصورة', 'Mansoura'] },
  { ar: 'شركة النقل الحديث', en: 'Modern Transport Co.', type: 'wholesale', limit: 100000, balance: 73500, branch: 'br-1', addr: ['العبور', 'Obour'] },
  { ar: 'إسلام فتحي', en: 'Islam Fathy', type: 'retail', limit: 0, balance: 0, branch: 'br-1', addr: ['عين شمس', 'Ain Shams'] },
  { ar: 'ورشة الإخلاص', en: 'Al-Ekhlas Workshop', type: 'workshop', limit: 18000, balance: 12200, branch: 'br-2', addr: ['إمبابة', 'Imbaba'] },
  { ar: 'وليد سامي (ديلفري)', en: 'Walid Samy (Delivery)', type: 'retail', limit: 3000, balance: 1200, branch: 'br-3', addr: ['سموحة', 'Smouha'] },
  { ar: 'مؤسسة الفاروق للتجارة', en: 'Al-Farouk Trading', type: 'wholesale', limit: 70000, balance: 35800, branch: 'br-2', addr: ['بولاق الدكرور', 'Boulaq El Dakrour'] },
  { ar: 'ورشة عم سيد', en: "Amm Sayed Workshop", type: 'workshop', limit: 10000, balance: 10850, branch: 'br-1', addr: ['السيدة زينب', 'Sayeda Zeinab'] },
  { ar: 'هشام عادل', en: 'Hesham Adel', type: 'retail', limit: 0, balance: 0, branch: 'br-4', addr: ['ميت غمر', 'Mit Ghamr'] },
  { ar: 'توكيل الشروق', en: 'Al-Shorouk Agency', type: 'wholesale', limit: 90000, balance: 0, branch: 'br-3', addr: ['برج العرب', 'Borg El Arab'] },
  { ar: 'ورشة الأمانة', en: 'Al-Amana Workshop', type: 'workshop', limit: 12000, balance: 4600, branch: 'br-2', addr: ['العمرانية', 'Omraneya'] },
  { ar: 'طارق محمود (سائق توك توك)', en: 'Tarek Mahmoud (Tuk-tuk Driver)', type: 'retail', limit: 1500, balance: 800, branch: 'br-1', addr: ['الزاوية الحمراء', 'Zawya El Hamra'] },
];

export const customers: Customer[] = custSeeds.map((c, i) => {
  const phone = `01${rng.pick(['0', '1', '2', '5'])}${rng.int(10000000, 99999999)}`;
  return {
    id: `cust-${i + 1}`, code: `C-${String(i + 1).padStart(4, '0')}`, name: { ar: c.ar, en: c.en }, phone, whatsapp: i % 5 === 3 ? '' : phone,
    address: { ar: c.addr[0], en: c.addr[1] }, type: c.type, creditLimit: c.limit, balance: c.balance, branchId: c.branch, isActive: i !== 17, createdAt: daysAgo(rng.int(30, 900)),
  };
});

export const cashRegisters: CashRegister[] = [
  { id: 'reg-1', code: 'CAI-01', name: { ar: 'خزنة العتبة 1', en: 'Ataba Register 1' }, branchId: 'br-1', isActive: true, currentSessionId: 'sess-open-1' },
  { id: 'reg-2', code: 'CAI-02', name: { ar: 'خزنة العتبة 2', en: 'Ataba Register 2' }, branchId: 'br-1', isActive: true, currentSessionId: null },
  { id: 'reg-3', code: 'CAI-03', name: { ar: 'خزنة العتبة 3', en: 'Ataba Register 3' }, branchId: 'br-1', isActive: false, currentSessionId: null },
  { id: 'reg-4', code: 'GIZ-01', name: { ar: 'خزنة فيصل 1', en: 'Faisal Register 1' }, branchId: 'br-2', isActive: true, currentSessionId: 'sess-open-2' },
  { id: 'reg-5', code: 'GIZ-02', name: { ar: 'خزنة فيصل 2', en: 'Faisal Register 2' }, branchId: 'br-2', isActive: true, currentSessionId: null },
  { id: 'reg-6', code: 'ALX-01', name: { ar: 'خزنة الإسكندرية 1', en: 'Alex Register 1' }, branchId: 'br-3', isActive: true, currentSessionId: 'sess-open-3' },
  { id: 'reg-7', code: 'ALX-02', name: { ar: 'خزنة الإسكندرية 2', en: 'Alex Register 2' }, branchId: 'br-3', isActive: true, currentSessionId: null },
  { id: 'reg-8', code: 'MNS-01', name: { ar: 'خزنة المنصورة', en: 'Mansoura Register' }, branchId: 'br-4', isActive: true, currentSessionId: null },
];

export const expenseCategories: ExpenseCategory[] = [
  { id: 'exc-1', name: { ar: 'إيجار', en: 'Rent' }, color: '#2563eb' },
  { id: 'exc-2', name: { ar: 'كهرباء ومياه', en: 'Utilities' }, color: '#0891b2' },
  { id: 'exc-3', name: { ar: 'رواتب', en: 'Salaries' }, color: '#9333ea' },
  { id: 'exc-4', name: { ar: 'نقل وشحن', en: 'Transport & Shipping' }, color: '#ea580c' },
  { id: 'exc-5', name: { ar: 'صيانة', en: 'Maintenance' }, color: '#dc2626' },
  { id: 'exc-6', name: { ar: 'مستلزمات مكتبية', en: 'Office Supplies' }, color: '#16a34a' },
  { id: 'exc-7', name: { ar: 'دعاية وإعلان', en: 'Marketing' }, color: '#be185d' },
  { id: 'exc-8', name: { ar: 'ضيافة', en: 'Hospitality' }, color: '#b45309' },
  { id: 'exc-9', name: { ar: 'أخرى', en: 'Other' }, color: '#64748b' },
];
