import { corsPreflight, json, requireAdmin } from '../_shared/supabase.ts';

function normalizeCheckerExamType(value: unknown): 'BECE' | 'WASSCE' | null {
  const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (normalized === 'BECE') return 'BECE';
  if (normalized === 'WASSCE' || normalized === 'NOV/DEC' || normalized === 'NOVDEC' || normalized === 'NOV-DEC') return 'WASSCE';
  return null;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { admin } = await requireAdmin(request);
    const { data, error } = await admin.from('result_checker_pins').select('exam_type, status');
    if (error) throw error;
    const stock = (data || []).reduce<Record<string, number>>((total, pin) => {
      const examType = normalizeCheckerExamType(pin.exam_type);
      if (pin.status === 'available' && examType) total[examType] = (total[examType] || 0) + 1;
      return total;
    }, {});
    stock['NOV/DEC'] = stock.WASSCE || 0;
    return json({ stock });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unable to load stock.' }, 403);
  }
});
