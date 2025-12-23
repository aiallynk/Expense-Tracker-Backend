import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import mongoose from 'mongoose';

import { s3Client, getS3Bucket } from '../config/aws';
import { config } from '../config/index';
import { openaiClient, getVisionModel } from '../config/openai';
import { Expense } from '../models/Expense';
import { OcrJob, IOcrJob } from '../models/OcrJob';
import { Receipt } from '../models/Receipt';
import { OcrJobStatus } from '../utils/enums';
import { logger } from '@/config/logger';

// ...
// Replace all togetherAIClient usages with openaiClient
//
// e.g. const response = await togetherAIClient.chat.completions.create({ ... })
//      => const response = await openaiClient.chat.completions.create({ ... })
//
// For class method names that include "TogetherAI", you can optionally rename to use "OpenAI" for clarity, but not required
// (no additional logic needed, just replacement)
