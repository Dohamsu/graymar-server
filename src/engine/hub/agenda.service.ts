import { Injectable } from '@nestjs/common';
import type {
  PlayerAgenda,
  ImplicitBuckets,
  ResolveResult,
  EventDefV2,
} from '../../db/types/index.js';

const BUCKET_KEYS: (keyof ImplicitBuckets)[] = [
  'destabilizeGuard',
  'allyMerchant',
  'empowerUnderworld',
  'exposeCorruption',
  'profitFromChaos',
];

const TAG_TO_BUCKET: Record<string, keyof ImplicitBuckets> = {
  destabilize: 'destabilizeGuard',
  merchant: 'allyMerchant',
  underworld: 'empowerUnderworld',
  corruption: 'exposeCorruption',
  chaos: 'profitFromChaos',
};

@Injectable()
export class AgendaService {
  initAgenda(): PlayerAgenda {
    return {
      explicit: { type: null, intensity: 1 },
      implicit: {
        destabilizeGuard: 0,
        allyMerchant: 0,
        empowerUnderworld: 0,
        exposeCorruption: 0,
        profitFromChaos: 0,
      },
      dominant: null,
    };
  }

  updateFromResolve(
    agenda: PlayerAgenda,
    resolveResult: ResolveResult,
    event: EventDefV2,
  ): PlayerAgenda {
    const newImplicit = { ...agenda.implicit };

    // resolveResult의 agendaBucketDelta 적용
    for (const [key, delta] of Object.entries(resolveResult.agendaBucketDelta)) {
      if (key in newImplicit) {
        newImplicit[key as keyof ImplicitBuckets] += delta;
      }
    }

    // event tags 기반 추가 증가
    for (const tag of event.payload.tags) {
      const bucket = TAG_TO_BUCKET[tag];
      if (bucket && resolveResult.outcome !== 'FAIL') {
        newImplicit[bucket] += 1;
      }
    }

    const dominant = this.computeDominant({ ...agenda, implicit: newImplicit });

    return {
      ...agenda,
      implicit: newImplicit,
      dominant,
    };
  }

  setExplicit(
    agenda: PlayerAgenda,
    type: string | null,
    intensity: 1 | 2 | 3,
  ): PlayerAgenda {
    return {
      ...agenda,
      explicit: { type, intensity },
    };
  }

  computeDominant(agenda: PlayerAgenda): string | null {
    let maxValue = 0;
    let dominant: string | null = null;

    for (const key of BUCKET_KEYS) {
      if (agenda.implicit[key] > maxValue) {
        maxValue = agenda.implicit[key];
        dominant = key;
      }
    }

    return maxValue > 0 ? dominant : null;
  }
}
