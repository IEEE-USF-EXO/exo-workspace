-- Run supabase-schema.sql first.
-- This imports the existing public.items export as the EXO BOM.

update public.bom_items
set
  component = replace(replace(replace(replace(component, 'â€”', '—'), 'â€“', '–'), 'Â', ''), '~=', '≈'),
  purpose = replace(replace(replace(replace(purpose, 'â€”', '—'), 'â€“', '–'), 'Â', ''), '~=', '≈'),
  supplier = replace(replace(replace(replace(supplier, 'â€”', '—'), 'â€“', '–'), 'Â', ''), '~=', '≈'),
  cost_basis = replace(replace(replace(replace(cost_basis, 'â€”', '—'), 'â€“', '–'), 'Â', ''), '~=', '≈');

insert into public.bom_items (
  project_id, item_id, subsystem, component, purpose, quantity,
  unit_cost, supplier, cost_basis, stage, source
)
select
  'exo',
  item_id,
  coalesce(subsystem, ''),
  replace(replace(replace(replace(component_name, 'â€”', '—'), 'â€“', '–'), 'Â', ''), '~=', '≈'),
  replace(replace(replace(replace(coalesce(purpose, ''), 'â€”', '—'), 'â€“', '–'), 'Â', ''), '~=', '≈'),
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
