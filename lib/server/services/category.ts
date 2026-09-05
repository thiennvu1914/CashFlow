import { prisma } from '@/lib/prisma'
import { createCategorySchema, type CreateCategoryInput } from '@/lib/validation/category'
import type { CategoryType } from '@prisma/client'

export async function listCategories(userId: string, type?: CategoryType) {
  return prisma.category.findMany({
    where: { userId, status: 'ACTIVE', ...(type ? { type } : {}) },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  })
}

export async function createCategory(userId: string, input: CreateCategoryInput) {
  const parsed = createCategorySchema.parse(input)
  return prisma.category.create({ data: { userId, ...parsed, isDefault: false } })
}

export async function archiveCategory(userId: string, categoryId: string) {
  return prisma.category.update({
    where: { userId_id: { userId, id: categoryId } },
    data: { status: 'ARCHIVED' },
  })
}
