/**
 * creditsStore — 积分经济体系场景共享状态。
 *
 * 充值页（余额展示）与会员页（签到后刷新余额）共享同一份
 * credits summary / specs / plans / signin 状态，任一页面刷新后另一页自动同步。
 */

import { create } from 'zustand';
import {
  getCreditsSummary,
  listRechargeSpecs,
  listPublicPlans,
  getSigninStatus,
  dailySignin,
  type CreditsSummary,
  type RechargeSpec,
  type PlanDefinition,
  type SigninStatus,
  type SigninResult,
} from '@/infrastructure/api/service-api/BillingApi';

interface CreditsStoreState {
  summary: CreditsSummary | null;
  specs: RechargeSpec[];
  plans: PlanDefinition[];
  signinStatus: SigninStatus | null;

  loadingSummary: boolean;
  loadingSpecs: boolean;
  loadingPlans: boolean;
  loadingSignin: boolean;

  loadSummary: () => Promise<void>;
  loadSpecs: () => Promise<void>;
  loadPlans: () => Promise<void>;
  loadSignin: () => Promise<void>;
  doSignin: () => Promise<SigninResult>;
}

export const useCreditsStore = create<CreditsStoreState>((set, get) => ({
  summary: null,
  specs: [],
  plans: [],
  signinStatus: null,

  loadingSummary: false,
  loadingSpecs: false,
  loadingPlans: false,
  loadingSignin: false,

  loadSummary: async () => {
    set({ loadingSummary: true });
    try {
      const summary = await getCreditsSummary();
      set({ summary });
    } finally {
      set({ loadingSummary: false });
    }
  },

  loadSpecs: async () => {
    if (get().specs.length > 0) return;
    set({ loadingSpecs: true });
    try {
      const resp = await listRechargeSpecs();
      const specs = [...(resp.items ?? [])].sort((a, b) => a.sort_order - b.sort_order);
      set({ specs });
    } finally {
      set({ loadingSpecs: false });
    }
  },

  loadPlans: async () => {
    if (get().plans.length > 0) return;
    set({ loadingPlans: true });
    try {
      const resp = await listPublicPlans();
      const plans = (resp.items ?? [])
        .filter(p => p.is_active)
        .sort((a, b) => a.sort_order - b.sort_order);
      set({ plans });
    } finally {
      set({ loadingPlans: false });
    }
  },

  loadSignin: async () => {
    set({ loadingSignin: true });
    try {
      const signinStatus = await getSigninStatus();
      set({ signinStatus });
    } finally {
      set({ loadingSignin: false });
    }
  },

  doSignin: async () => {
    const result = await dailySignin();
    // 签到成功 → 立即刷新余额与签到状态（余额在充值页同步可见）
    await Promise.all([get().loadSummary(), get().loadSignin()]);
    return result;
  },
}));
