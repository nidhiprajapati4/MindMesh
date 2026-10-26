import { Router } from 'express';
import { getUsage } from '../../platform/quota';
import { searchQuerySchema } from './search.schema';
import { search } from './search.service';

const router = Router();

// GET /api/search?q=&mode=keyword|semantic|hybrid&type=&folder=&tag=&limit=
router.get('/', async (req, res) => {
  res.json(await search(req.auth!.userId, searchQuerySchema.parse(req.query)));
});

// Today's AI usage against the daily budget.
router.get('/usage', async (req, res) => {
  res.json(await getUsage(req.auth!.userId));
});

export default router;
