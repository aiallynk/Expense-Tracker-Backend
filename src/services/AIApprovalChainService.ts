import { z } from 'zod';

import { callOpenAI } from './openaiWrapper.service';

import { logger } from '@/config/logger';

export const aiApprovalChainSchema = z.object({
  approverChain: z.array(z.object({
    level: z.number().min(1),
    mode: z.enum(['SEQUENTIAL', 'PARALLEL']),
    approvalType: z.enum(['ANY', 'ALL']).nullable(),
    roles: z.array(z.string().min(1)),
  })),
  confidenceScore: z.number().min(0).max(1),
  reasoningSummary: z.string(),
});

export class AIApprovalChainService {
  static async generate({ employee, companyMatrix, risk }: { employee: any; companyMatrix: any; risk: any }) {
    const systemPrompt = [
      "You are an expert approval matrix AI.",
      "You only reply with strict JSON. Never approve/reject expense reports. Only suggest the approver chain.",
      "No explanations. Output must exactly match this JSON schema:",
      JSON.stringify(aiApprovalChainSchema._def),
      "Input example includes: department, designation, grade, company matrix, historical risk.",
      "Fields: level, mode, approvalType, roles (role code or name, to be mapped), confidenceScore, reasoningSummary (max 1 sentence)."
    ].join(' ');

    const userPrompt = `Input: ${JSON.stringify({
      department: employee.department,
      designation: employee.designation,
      grade: employee.grade,
      risk,
      companyMatrix
    })}`;

    const completion = await callOpenAI({
      companyId: (employee as any)?.companyId?.toString?.() || 'unknown',
      userId: (employee as any)?.userId?.toString?.() || (employee as any)?.id?.toString?.() || 'unknown',
      feature: 'AI_ASSIST',
      model: 'gpt-4-1106-preview',
      temperature: 0.0,
      max_tokens: 512,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' }
    });

    let aiJson;
    try {
      aiJson = JSON.parse(completion.choices[0].message.content || '{}');
    } catch (err) {
      logger.error({ err, content: completion.choices[0].message.content }, 'AIApprovalChainService: JSON parse fail');
      throw new Error('AI did not return valid JSON');
    }

    const validated = aiApprovalChainSchema.safeParse(aiJson);
    if (!validated.success) {
      logger.error({ aiJson, issues: validated.error.issues }, 'AIApprovalChainService: Invalid output shape');
      throw new Error('AI output did not match approval chain schema');
    }
    return validated.data;
  }
}

