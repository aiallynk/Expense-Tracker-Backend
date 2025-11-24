import { UserRole } from '../src/utils/enums';

console.log('Available UserRole enum values:');
console.log(Object.values(UserRole));

console.log('\nChecking if SUPER_ADMIN and COMPANY_ADMIN are included:');
console.log('SUPER_ADMIN:', Object.values(UserRole).includes('SUPER_ADMIN'));
console.log('COMPANY_ADMIN:', Object.values(UserRole).includes('COMPANY_ADMIN'));

console.log('\nAll roles:', Object.values(UserRole).join(', '));

