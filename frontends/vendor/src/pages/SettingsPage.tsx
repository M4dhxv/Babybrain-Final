import { useEffect, useState } from 'react';
import {
  User, MapPin, Users, Shield, Store, ChevronRight, Pencil, FileText,
  CheckCircle, Clock, CreditCard, MessageSquare, Star, HelpCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { apiPost } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import type { ProviderLocation } from '@/lib/database.types';

const settingsTabs = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'locations', label: 'Locations', icon: MapPin },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'compliance', label: 'Compliance', icon: Shield },
];

// Compliance acceptances aren't modelled as a table in the MVP backend — kept static.
const complianceItems = [
  { icon: FileText, label: 'Vendor Terms', status: 'Accepted', statusColor: 'text-green-600', bg: 'bg-green-100', accepted: true },
  { icon: Clock, label: 'PDPA Acknowledgement', status: 'Accepted', statusColor: 'text-green-600', bg: 'bg-green-100', accepted: true },
  { icon: Store, label: 'Child Photo Consent Warranty', status: 'Accepted', statusColor: 'text-green-600', bg: 'bg-green-100', accepted: true },
  { icon: Shield, label: 'Review Policy', status: 'Accepted', statusColor: 'text-green-600', bg: 'bg-green-100', accepted: true },
  { icon: CreditCard, label: 'Refund Policy', status: 'Edit', statusColor: 'text-blue-600', bg: 'bg-blue-100', accepted: false },
  { icon: MessageSquare, label: 'Messaging Rules', status: 'Accepted', statusColor: 'text-green-600', bg: 'bg-green-100', accepted: true },
  { icon: Star, label: 'Featured Placement Disclosure', status: 'N/A until Boost', statusColor: 'text-gray-500', bg: 'bg-gray-100', accepted: false },
];

type Member = { id: string; user_id: string; role: string; invited_email: string | null; status: string };

export default function SettingsPage() {
  const { provider, role, session, refreshProvider } = useAuth();
  const canManage = role === 'owner' || role === 'manager';

  const [activeTab, setActiveTab] = useState('profile');
  const [locations, setLocations] = useState<ProviderLocation[]>([]);
  const [team, setTeam] = useState<Member[]>([]);
  const [form, setForm] = useState({
    business_name: '', contact_phone: '', contact_email: '', website: '', description: '',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'manager' | 'staff'>('staff');
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const isOwner = role === 'owner';

  useEffect(() => {
    if (!provider) return;
    setForm({
      business_name: provider.business_name ?? '',
      contact_phone: provider.contact_phone ?? '',
      contact_email: provider.contact_email ?? '',
      website: provider.website ?? '',
      description: provider.description ?? '',
    });
    supabase.from('provider_locations').select('*').eq('provider_id', provider.id)
      .then(({ data }) => setLocations(data ?? []));
    supabase.from('provider_members').select('id, user_id, role, invited_email, status').eq('provider_id', provider.id)
      .then(({ data }) => setTeam((data as Member[]) ?? []));
  }, [provider]);

  async function saveProfile() {
    if (!provider) return;
    setSaving(true);
    setSaved(false);
    await supabase.from('providers').update({
      business_name: form.business_name,
      contact_phone: form.contact_phone || null,
      contact_email: form.contact_email || null,
      website: form.website || null,
      description: form.description,
    }).eq('id', provider.id);
    setSaving(false);
    setSaved(true);
    await refreshProvider();
  }

  async function inviteMember() {
    if (!provider || !inviteEmail.trim()) return;
    setInviting(true);
    setInviteMsg(null);
    try {
      const res = await apiPost<{ ok: boolean; linked: boolean }>('/api/vendor/staff/invite', {
        provider_id: provider.id,
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      setInviteMsg({
        ok: true,
        text: res.linked
          ? 'Added to your team — they already have an account.'
          : 'Invite sent. They join automatically when they sign up with this email.',
      });
      setInviteEmail('');
      const { data } = await supabase
        .from('provider_members')
        .select('id, user_id, role, invited_email, status')
        .eq('provider_id', provider.id);
      setTeam((data as Member[]) ?? []);
    } catch (e) {
      setInviteMsg({ ok: false, text: e instanceof Error ? e.message : 'Invite failed' });
    } finally {
      setInviting(false);
    }
  }

  const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-pink-200';

  return (
    <div className="relative">
      <div className="flex items-center justify-between px-8 py-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Manage your business profile, locations, team and compliance.</p>
        </div>
      </div>

      <div className="px-8 pb-8">
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6 w-fit">
          {settingsTabs.map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={cn('flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors',
                activeTab === tab.id ? 'bg-white text-[#E91E63] shadow-sm' : 'text-gray-600 hover:text-gray-900')}>
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'profile' && (
          <div className="grid grid-cols-3 gap-6">
            {/* Business Profile */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-5">
                <h3 className="font-semibold text-gray-900">Business Profile</h3>
              </div>
              <div className="flex items-center gap-4 mb-5">
                <div className="w-16 h-16 rounded-full bg-pink-100 flex items-center justify-center overflow-hidden">
                  {provider?.logo_url ? <img src={provider.logo_url} alt="" className="w-full h-full object-cover" /> : <Store className="w-8 h-8 text-[#E91E63]" />}
                </div>
                <div>
                  <h4 className="text-lg font-bold text-gray-900">{form.business_name || 'Your business'}</h4>
                  <div className="text-xs text-gray-500 mb-1">Profile Completion</div>
                  <div className="flex items-center gap-2">
                    <Progress value={completion(form)} className="w-32 h-2" />
                    <span className="text-sm font-semibold text-gray-900">{completion(form)}%</span>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Business Name</label>
                    <input className={inputCls} value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} disabled={!canManage} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Phone Number</label>
                    <input className={inputCls} value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} disabled={!canManage} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Email</label>
                    <input className={inputCls} value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} disabled={!canManage} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Website</label>
                    <input className={inputCls} value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} disabled={!canManage} />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Business Description</label>
                  <textarea rows={2} className={cn(inputCls, 'resize-none')} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} disabled={!canManage} />
                </div>
              </div>

              {canManage && (
                <div className="flex items-center gap-3 mt-5">
                  <Button onClick={saveProfile} disabled={saving} className="gradient-primary text-white rounded-xl hover:opacity-90 px-6">
                    {saving ? 'Saving…' : 'Save Changes'}
                  </Button>
                  {saved && <span className="text-sm text-green-600">Saved ✓</span>}
                </div>
              )}
            </div>

            {/* Locations (live) */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center"><MapPin className="w-5 h-5 text-purple-600" /></div>
                <div>
                  <h3 className="font-semibold text-gray-900">Locations</h3>
                  <p className="text-xs text-gray-500">{locations.length} Active Location{locations.length === 1 ? '' : 's'}</p>
                </div>
              </div>
              <div className="space-y-3 mb-5">
                {locations.map((loc) => (
                  <div key={loc.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-pink-100 text-[#E91E63]"><Store className="w-5 h-5" /></div>
                    <div className="flex-1">
                      <div className="font-medium text-gray-900 text-sm">{loc.name}</div>
                      <div className="text-xs text-gray-500">{loc.is_primary ? 'Main Branch' : 'Branch'}</div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-gray-400" />
                  </div>
                ))}
                {locations.length === 0 && <div className="text-sm text-gray-400">No locations added yet.</div>}
              </div>
            </div>

            {/* Compliance (static) */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center"><Shield className="w-5 h-5 text-purple-600" /></div>
                <div>
                  <h3 className="font-semibold text-gray-900">Compliance</h3>
                  <p className="text-xs text-gray-500">Keep your profile compliant and up to date.</p>
                </div>
              </div>
              <div className="space-y-3">
                {complianceItems.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                    <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', item.bg)}><item.icon className={cn('w-4 h-4', item.statusColor)} /></div>
                    <div className="flex-1"><div className="text-sm font-medium text-gray-900">{item.label}</div></div>
                    {item.accepted ? (
                      <span className="flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full"><CheckCircle className="w-3 h-3" />Accepted</span>
                    ) : item.status === 'Edit' ? (
                      <button className="flex items-center gap-1 px-3 py-1.5 border border-blue-200 rounded-lg text-xs text-blue-600 hover:bg-blue-50"><Pencil className="w-3 h-3" />Edit</button>
                    ) : (
                      <span className="flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-500 text-xs rounded-full"><HelpCircle className="w-3 h-3" />{item.status}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Team (live) */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-green-100 flex items-center justify-center"><Users className="w-5 h-5 text-green-600" /></div>
                <div>
                  <h3 className="font-semibold text-gray-900">Team Members</h3>
                  <p className="text-xs text-gray-500">{team.length} Team Member{team.length === 1 ? '' : 's'}</p>
                </div>
              </div>
              <div className="space-y-3 mb-5">
                {team.map((m) => {
                  const isYou = m.user_id === session?.user.id;
                  const label = isYou ? 'You' : m.invited_email ?? 'Member';
                  return (
                    <div key={m.id} className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold bg-green-100 text-green-600">
                        {(label[0] ?? '?').toUpperCase()}
                      </div>
                      <div className="flex-1"><div className="text-sm font-medium text-gray-900 truncate">{label}</div></div>
                      <span className={cn('px-2 py-0.5 text-xs rounded-full capitalize',
                        m.role === 'owner' ? 'bg-green-100 text-green-700' : m.role === 'manager' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700')}>
                        {m.role}
                      </span>
                    </div>
                  );
                })}
              </div>
              {isOwner ? (
                <div className="border-t border-gray-100 pt-4">
                  <label className="text-xs font-medium text-gray-500 mb-2 block">Invite a team member</label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="email"
                      placeholder="name@email.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      className="flex-1 px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-green-200"
                    />
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as 'manager' | 'staff')}
                      className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white">
                      <option value="staff">Staff</option>
                      <option value="manager">Manager</option>
                    </select>
                    <button
                      onClick={inviteMember}
                      disabled={inviting || !inviteEmail.trim()}
                      className="flex items-center justify-center gap-1 px-4 py-2 bg-green-600 rounded-xl text-xs font-medium text-white disabled:opacity-50">
                      <Users className="w-3 h-3" /> {inviting ? 'Inviting…' : 'Invite'}
                    </button>
                  </div>
                  {inviteMsg && (
                    <p className={cn('text-xs mt-2', inviteMsg.ok ? 'text-green-600' : 'text-red-600')}>{inviteMsg.text}</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-gray-400 text-center">Only the business owner can invite team members.</p>
              )}
            </div>
          </div>
        )}

        {activeTab !== 'profile' && (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              {activeTab === 'locations' && <MapPin className="w-8 h-8 text-gray-400" />}
              {activeTab === 'team' && <Users className="w-8 h-8 text-gray-400" />}
              {activeTab === 'compliance' && <Shield className="w-8 h-8 text-gray-400" />}
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              {activeTab === 'locations' && 'Locations Management'}
              {activeTab === 'team' && 'Team Management'}
              {activeTab === 'compliance' && 'Compliance Center'}
            </h3>
            <p className="text-sm text-gray-500 max-w-md mx-auto">Detailed management for this section uses the Profile tab cards for now.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function completion(f: { business_name: string; contact_phone: string; contact_email: string; website: string; description: string }) {
  const fields = [f.business_name, f.contact_phone, f.contact_email, f.website, f.description];
  return Math.round((fields.filter(Boolean).length / fields.length) * 100);
}
