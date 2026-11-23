-- Accord des libellés (Présent / Présente…) : genre de chaque employé, modifiable par le gérant
alter table public.hr_employes add column if not exists genre text check (genre in ('h', 'f'));
