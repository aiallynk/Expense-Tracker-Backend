
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Role, RoleType } from '../src/models/Role';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error('Missing MONGODB_URI in environment variables');
    process.exit(1);
}

const migrateRoles = async () => {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB');

        // Update all roles that don't have a type to be SYSTEM roles
        // Assuming all currently existing roles before this feature are "System" legacy roles.
        // Or strictly, we might want to check names. But for now, let's make all existing ones SYSTEM for safety,
        // so they can't be deleted easily.
        const result = await Role.updateMany(
            { type: { $exists: false } },
            { $set: { type: RoleType.SYSTEM } }
        );

        console.log(`Migration complete. Updated ${result.modifiedCount} roles to SYSTEM type.`);

        // Safety check: ensure all roles have a type now
        const rolesWithoutType = await Role.countDocuments({ type: { $exists: false } });
        if (rolesWithoutType > 0) {
            console.warn(`WARNING: ${rolesWithoutType} roles still have no type!`);
        } else {
            console.log('Verification successful: All roles have a type.');
        }

    } catch (error) {
        console.error('Migration failed:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB');
    }
};

migrateRoles();
