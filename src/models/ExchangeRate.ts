import mongoose, { Document, Schema } from 'mongoose';

export interface IExchangeRate extends Document {
  base: string; // Base currency (always "INR")
  rates: {
    [currency: string]: number; // Exchange rates from INR to other currencies
  };
  date: string; // Date in YYYY-MM-DD format for daily rates
  lastUpdated: Date; // Timestamp when rates were fetched
  createdAt: Date;
  updatedAt: Date;
}

const exchangeRateSchema = new Schema<IExchangeRate>(
  {
    base: {
      type: String,
      required: true,
      default: 'INR',
      index: true,
    },
    rates: {
      type: Map,
      of: Number,
      required: true,
    },
    date: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    lastUpdated: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// TTL index to auto-delete rates older than 90 days
exchangeRateSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// Compound index for efficient queries
exchangeRateSchema.index({ base: 1, date: 1 }, { unique: true });

export const ExchangeRate = mongoose.model<IExchangeRate>('ExchangeRate', exchangeRateSchema);

