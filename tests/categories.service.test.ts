import { createTestCompany } from './utils/testHelpers';
import { CategoriesService } from '../src/services/categories.service';
import { Category, ICategory } from '../src/models/Category';

function idStr(cat: ICategory): string {
  return (cat as ICategory & { _id: { toString(): string } })._id.toString();
}

describe('CategoriesService – per-company category uniqueness', () => {
  describe('createCategory', () => {
    it('allows same category name in different companies', async () => {
      const companyAId = await createTestCompany('Company A');
      const companyBId = await createTestCompany('Company B');

      const fuelA = await CategoriesService.createCategory({
        name: 'Fuel',
        companyId: companyAId,
      });
      const fuelB = await CategoriesService.createCategory({
        name: 'Fuel',
        companyId: companyBId,
      });

      expect(fuelA).toBeDefined();
      expect(fuelB).toBeDefined();
      expect(idStr(fuelA)).not.toBe(idStr(fuelB));
      expect(fuelA.name).toBe('Fuel');
      expect(fuelB.name).toBe('Fuel');
      expect(fuelA.companyId?.toString()).toBe(companyAId);
      expect(fuelB.companyId?.toString()).toBe(companyBId);

      const count = await Category.countDocuments({ name: 'Fuel' });
      expect(count).toBe(2);
    });

    it('returns existing category or fails with duplicate message when creating same name twice for same company', async () => {
      const companyAId = await createTestCompany('Company A');

      const first = await CategoriesService.createCategory({
        name: 'Fuel',
        companyId: companyAId,
      });
      expect(first).toBeDefined();

      const second = await CategoriesService.createCategory({
        name: 'Fuel',
        companyId: companyAId,
      });
      expect(second).toBeDefined();
      expect(idStr(second)).toBe(idStr(first));

      const count = await Category.countDocuments({
        name: 'Fuel',
        companyId: first.companyId,
      });
      expect(count).toBe(1);
    });

    it('getCategoryByName returns only the category for the given company', async () => {
      const companyAId = await createTestCompany('Company A');
      const companyBId = await createTestCompany('Company B');

      await CategoriesService.createCategory({ name: 'Medical', companyId: companyAId });
      await CategoriesService.createCategory({ name: 'Medical', companyId: companyBId });

      const forA = await CategoriesService.getCategoryByName('Medical', companyAId);
      const forB = await CategoriesService.getCategoryByName('Medical', companyBId);

      expect(forA).toBeDefined();
      expect(forB).toBeDefined();
      expect(idStr(forA!)).not.toBe(idStr(forB!));
      expect(forA!.companyId?.toString()).toBe(companyAId);
      expect(forB!.companyId?.toString()).toBe(companyBId);
    });

    it('getOrCreateCategoryByName returns company-specific category and creates only for that company', async () => {
      const companyAId = await createTestCompany('Company A');
      const companyBId = await createTestCompany('Company B');

      const catA1 = await CategoriesService.getOrCreateCategoryByName('Food', companyAId);
      const catB1 = await CategoriesService.getOrCreateCategoryByName('Food', companyBId);
      const catA2 = await CategoriesService.getOrCreateCategoryByName('Food', companyAId);

      expect(idStr(catA1)).toBe(idStr(catA2));
      expect(idStr(catB1)).not.toBe(idStr(catA1));
      expect(catA1.companyId?.toString()).toBe(companyAId);
      expect(catB1.companyId?.toString()).toBe(companyBId);

      const count = await Category.countDocuments({ name: 'Food' });
      expect(count).toBe(2);
    });
  });
});
