// Campaign display helpers: the campaign type labels and badge classes, the grouping of the campaign menu.
import type { Campaign } from './lib/types';

export const TYPE_LABELS: Record<string, string> = { SALES: 'Sales', TECH: 'Tech', TEACHER: 'Teacher' };

export const typeBadgeClass = (code: string | undefined): string => {
  const slug = String(code || '').toLowerCase();
  return `badge${['sales', 'tech', 'teacher'].includes(slug) ? ` badge-${slug}` : ''}`;
};

export const campaignLabel = (c: Campaign): string => (c.group ? `${c.group} — ${c.name}` : c.name);

export interface CampaignGroup {
  key: string;
  name: string;
  items: Campaign[];
}

/** The campaigns by group (campaigns without one come first, under no heading), groups in name order. */
export function groupCampaigns(list: Campaign[]): CampaignGroup[] {
  const map = new Map<string, CampaignGroup>();
  for (const c of list) {
    const name = c.group || '';
    if (!map.has(name)) map.set(name, { key: name || '_', name, items: [] });
    map.get(name)?.items.push(c);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
