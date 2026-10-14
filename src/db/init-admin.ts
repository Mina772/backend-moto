import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../config/env.js';
import { newId, nowISO } from '../lib/ids.js';
import { connectDb, disconnectDb } from './connect.js';
import { ensureBootstrap } from './bootstrap.js';
import { BranchModel, CashRegisterModel, UserModel, WarehouseModel } from './models.js';

/**
 * Creates the first branch, main warehouse, register and administrator from operator-supplied details.
 *
 *   ADMIN_USERNAME=admin ADMIN_PASSWORD=... BRANCH_NAME_AR='الفرع الرئيسي' node dist/db/init-admin.js
 */
const ArgsSchema = z.object({
  ADMIN_USERNAME: z.string().regex(/^[a-z0-9._-]{3,32}$/, 'lowercase letters, digits, . _ - (3-32 chars)').default('admin'),
  ADMIN_PASSWORD: z.string().min(10, 'ADMIN_PASSWORD must be at least 10 characters'),
  ADMIN_FULL_NAME_AR: z.string().min(2).default('مدير النظام'),
  ADMIN_FULL_NAME_EN: z.string().min(2).default('System Administrator'),
  ADMIN_EMAIL: z.string().email().or(z.literal('')).default(''),
  ADMIN_PHONE: z.string().default(''),
  BRANCH_CODE: z.string().regex(/^[A-Z0-9-]{2,10}$/, 'uppercase letters, digits and dashes').default('MAIN'),
  BRANCH_NAME_AR: z.string().trim().min(2, 'Provide the real branch name'),
  BRANCH_NAME_EN: z.string().trim().default(''),
  BRANCH_CITY_AR: z.string().trim().min(2, 'Provide the real branch city'),
  BRANCH_CITY_EN: z.string().trim().default(''),
  BRANCH_ADDRESS_AR: z.string().trim().min(2, 'Provide the real branch address'),
  BRANCH_ADDRESS_EN: z.string().trim().default(''),
  BRANCH_PHONE: z.string().default(''),
});

async function main() {
  const parsed = ArgsSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid input:');
    for (const [key, messages] of Object.entries(parsed.error.flatten().fieldErrors)) {
      console.error(`  - ${key}: ${messages?.join(', ')}`);
    }
    process.exit(1);
  }
  const a = parsed.data;

  await connectDb();
  await ensureBootstrap();

  if (await UserModel.exists({ username: a.ADMIN_USERNAME })) {
    console.error(`User "${a.ADMIN_USERNAME}" already exists — nothing to do.`);
    await disconnectDb();
    process.exit(1);
  }

  const now = nowISO();
  let branch = await BranchModel.findOne({ code: a.BRANCH_CODE });
  if (!branch) {
    branch = await BranchModel.create({
      _id: newId('br'),
      code: a.BRANCH_CODE,
      name: { ar: a.BRANCH_NAME_AR, en: a.BRANCH_NAME_EN },
      city: { ar: a.BRANCH_CITY_AR, en: a.BRANCH_CITY_EN },
      address: { ar: a.BRANCH_ADDRESS_AR, en: a.BRANCH_ADDRESS_EN },
      phone: a.BRANCH_PHONE,
      isActive: true,
      posTerminals: 1,
      openedAt: now,
    });
    console.log(`branch created: ${branch._id} (${a.BRANCH_CODE})`);
  }

  const warehouseCode = `${a.BRANCH_CODE}-MAIN`;
  if (!(await WarehouseModel.exists({ code: warehouseCode }))) {
    const warehouse = await WarehouseModel.create({
      _id: newId('wh'),
      code: warehouseCode,
      name: { ar: `مخزن ${a.BRANCH_NAME_AR}`, en: `${a.BRANCH_NAME_EN} Warehouse` },
      branchId: branch._id,
      isActive: true,
      isMain: true,
      locations: [],
      capacity: 0,
    });
    console.log(`warehouse created: ${warehouse._id} (${warehouseCode})`);
  }

  const registerCode = `${a.BRANCH_CODE}-REG-1`;
  if (!(await CashRegisterModel.exists({ code: registerCode }))) {
    const register = await CashRegisterModel.create({
      _id: newId('reg'),
      code: registerCode,
      name: { ar: 'الخزنة الرئيسية', en: 'Main Register' },
      branchId: branch._id,
      isActive: true,
      currentSessionId: null,
    });
    console.log(`register created: ${register._id} (${registerCode})`);
  }

  const user = await UserModel.create({
    _id: newId('usr'),
    username: a.ADMIN_USERNAME,
    passwordHash: await bcrypt.hash(a.ADMIN_PASSWORD, env.BCRYPT_COST),
    refreshTokens: [],
    fullName: { ar: a.ADMIN_FULL_NAME_AR, en: a.ADMIN_FULL_NAME_EN },
    email: a.ADMIN_EMAIL,
    phone: a.ADMIN_PHONE,
    role: 'admin',
    branchId: branch._id,
    status: 'active',
    createdAt: now,
  });
  console.log(`admin created: ${user._id} (${a.ADMIN_USERNAME}) on branch ${branch._id}`);

  await BranchModel.updateOne({ _id: branch._id, managerId: '' }, { $set: { managerId: user._id } });
  await disconnectDb();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
