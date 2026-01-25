import mongoose from 'mongoose';
import { config } from '../../src/config';
import { AdvanceCash } from '../../src/models/AdvanceCash';
import { logger } from '../../src/config/logger';

/**
 * Migration script to ensure all vouchers have voucherCode
 * Generates 5-8 digit codes for vouchers missing codes
 */
async function ensureVoucherCodes() {
  try {
    // Connect to database
    await mongoose.connect(config.mongoUri);
    logger.info('Connected to MongoDB');

    // Find all vouchers without voucherCode
    const vouchersWithoutCode = await AdvanceCash.find({
      $or: [
        { voucherCode: { $exists: false } },
        { voucherCode: null },
        { voucherCode: '' },
      ],
    }).exec();

    logger.info(`Found ${vouchersWithoutCode.length} vouchers without voucherCode`);

    if (vouchersWithoutCode.length === 0) {
      logger.info('All vouchers already have voucherCode');
      await mongoose.disconnect();
      return;
    }

    // Helper function to generate 5-8 digit voucher code
    const generateVoucherCode = (): string => {
      const digits = Math.floor(Math.random() * 4) + 5; // 5-8 digits
      const code = Math.floor(Math.random() * Math.pow(10, digits))
        .toString()
        .padStart(digits, '0');
      return `VCH-${code}`;
    };

    let updated = 0;
    let errors = 0;

    // Update each voucher
    for (const voucher of vouchersWithoutCode) {
      try {
        let voucherCode: string;
        let unique = false;
        let attempts = 0;

        // Generate unique code
        while (!unique && attempts < 20) {
          voucherCode = generateVoucherCode();
          const exists = await AdvanceCash.findOne({ voucherCode }).exec();
          if (!exists) {
            unique = true;
          }
          attempts++;
        }

        if (!unique) {
          logger.error(
            { voucherId: voucher._id },
            'Could not generate unique voucher code after 20 attempts'
          );
          errors++;
          continue;
        }

        // Update voucher
        voucher.voucherCode = voucherCode!;
        await voucher.save();

        updated++;
        logger.debug(
          { voucherId: voucher._id, voucherCode: voucherCode! },
          'Assigned voucher code'
        );
      } catch (error) {
        logger.error({ error, voucherId: voucher._id }, 'Error updating voucher code');
        errors++;
      }
    }

    logger.info(
      {
        total: vouchersWithoutCode.length,
        updated,
        errors,
      },
      'Migration completed'
    );

    await mongoose.disconnect();
    logger.info('Disconnected from MongoDB');
  } catch (error) {
    logger.error({ error }, 'Migration failed');
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run migration if called directly
if (require.main === module) {
  ensureVoucherCodes()
    .then(() => {
      logger.info('Migration script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ error }, 'Migration script failed');
      process.exit(1);
    });
}

export { ensureVoucherCodes };
