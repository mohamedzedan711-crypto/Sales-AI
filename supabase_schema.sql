-- Leads table
create table leads (
  id uuid default gen_random_uuid() primary key,
  business_name text,
  contact_name text,
  email text,
  phone text,
  source text,
  stage text default 'New Lead',
  practice_type text,
  location text,
  proposal_value numeric,
  last_contact date,
  next_followup date,
  notes text,
  created_at timestamp default now(),
  updated_at timestamp default now()
);

-- Communications log
create table comm_log (
  id uuid default gen_random_uuid() primary key,
  lead_id uuid references leads(id) on delete cascade,
  type text,
  subject text,
  content text,
  sent_at timestamp default now()
);

-- Proposals
create table proposals (
  id uuid default gen_random_uuid() primary key,
  lead_id uuid references leads(id) on delete cascade,
  content text,
  value numeric,
  status text default 'Draft',
  created_at timestamp default now()
);

-- Follow ups
create table followups (
  id uuid default gen_random_uuid() primary key,
  lead_id uuid references leads(id) on delete cascade,
  type text,
  sent_date date,
  next_date date,
  count integer default 0,
  status text default 'Waiting',
  created_at timestamp default now()
);

-- DM log
create table dm_log (
  id uuid default gen_random_uuid() primary key,
  platform text,
  sender text,
  message text,
  reply text,
  processed_at timestamp default now()
);

-- Call notes
create table call_notes (
  id uuid default gen_random_uuid() primary key,
  lead_id uuid references leads(id) on delete cascade,
  lead_name text,
  call_type text,
  call_date date,
  caller_name text,
  duration text,
  raw_notes text,
  call_overview text,
  pain_points jsonb,
  goals jsonb,
  objections jsonb,
  services_to_propose jsonb,
  next_steps jsonb,
  recommended_value numeric,
  created_at timestamp default now()
);

-- Enable Row Level Security
alter table leads enable row level security;
alter table comm_log enable row level security;
alter table proposals enable row level security;
alter table followups enable row level security;
alter table dm_log enable row level security;
alter table call_notes enable row level security;

-- Allow all operations for now (tighten later)
create policy "allow all" on leads for all using (true);
create policy "allow all" on comm_log for all using (true);
create policy "allow all" on proposals for all using (true);
create policy "allow all" on followups for all using (true);
create policy "allow all" on dm_log for all using (true);
create policy "allow all" on call_notes for all using (true);
