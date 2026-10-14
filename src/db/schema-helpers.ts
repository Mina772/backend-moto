import { Schema, type SchemaDefinition } from 'mongoose';

export const LocalizedTextSchema = new Schema({ ar: { type: String, default: '' }, en: { type: String } }, { _id: false });

function transform(_doc: unknown, ret: Record<string, unknown>) {
  ret.id = ret._id;
  delete ret._id;
  delete ret.passwordHash;
  delete ret.authVersion;
  delete ret.refreshTokens;
  return ret;
}

// Mongoose's transform generics don't accept a generic T cleanly; options are typed loosely on purpose.
const baseOptions = {
  versionKey: false,
  timestamps: false,
  minimize: false,
  toJSON: { virtuals: true, transform },
  toObject: { virtuals: true, transform },
} as Record<string, unknown>;

/** Shared options: string `_id` surfaced as `id`, no `__v`, dates stored as ISO strings. */
export function defineSchema<T>(def: SchemaDefinition, opts: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Schema<T>({ _id: { type: String, required: true }, ...def }, { ...baseOptions, ...opts } as any);
}

export const Mixed = Schema.Types.Mixed;
