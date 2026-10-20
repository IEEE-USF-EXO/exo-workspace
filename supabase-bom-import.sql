-- Run supabase-schema.sql first.
-- This imports the existing public.items export as the EXO BOM.

insert into public.bom_items (
  project_id, item_id, subsystem, component, purpose, quantity,
  unit_cost, supplier, cost_basis, stage, source
)
select
  'exo',
  item_id,
  coalesce(subsystem, ''),
  component_name,
  coalesce(purpose, ''),
  coalesce(qty, 1),
  unit_cost,
  coalesce(supplier_link, ''),
  coalesce(cost_basis, 'Baseline'),
  coalesce(stage, 'Baseline'),
  'public.items import'
from public.items
where not exists (
  select 1
  from public.bom_items existing
  where existing.project_id = 'exo'
    and existing.item_id = public.items.item_id
);
