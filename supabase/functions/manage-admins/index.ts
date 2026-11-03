import { corsPreflight, json, requireSuperAdmin } from '../_shared/supabase.ts';

const PRIMARY_SUPER_ADMIN_EMAIL = 'seidumobiriahidu@gmail.com';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();

  try {
    const { admin, user: caller } = await requireSuperAdmin(request);

    // Parse body once for POST requests (the Supabase JS client always sends POST via invoke)
    let body: Record<string, unknown> = {};
    if (request.method === 'POST') {
      body = await request.json().catch(() => ({})) as Record<string, unknown>;
    }
    const action = String(body.action || '').trim();

    // GET or POST-with-no-action: List all active admin accounts
    if (request.method === 'GET' || (request.method === 'POST' && !action)) {
      const [agentsRes, authUsersRes] = await Promise.all([
        admin
          .from('agents')
          .select('id, full_name, role, phone, agent_code, created_at, updated_at')
          .in('role', ['admin', 'super_admin'])
          .order('created_at', { ascending: false }),
        admin.auth.admin.listUsers({ perPage: 1000 }),
      ]);

      if (agentsRes.error) throw agentsRes.error;
      if (authUsersRes.error) throw authUsersRes.error;

      const userMap = new Map<string, { email?: string; last_sign_in_at?: string }>();
      for (const u of authUsersRes.data.users) {
        userMap.set(u.id, {
          email: u.email,
          last_sign_in_at: u.last_sign_in_at,
        });
      }

      const admins = (agentsRes.data || []).map((a) => {
        const u = userMap.get(a.id);
        const email = u?.email || '';
        const isPrimaryOwner = email.toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL.toLowerCase();

        return {
          id: a.id,
          fullName: a.full_name || 'Admin User',
          email,
          role: isPrimaryOwner ? 'super_admin' : a.role,
          phone: a.phone || '',
          agentCode: a.agent_code || '',
          createdAt: a.created_at,
          lastSignInAt: u?.last_sign_in_at || null,
          isPrimaryOwner,
        };
      });

      // Ensure the primary owner is listed even if role was not yet queried
      const hasPrimary = admins.some((adm) => adm.email.toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL.toLowerCase());
      if (!hasPrimary) {
        const primaryUser = authUsersRes.data.users.find(
          (u) => (u.email || '').toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL.toLowerCase()
        );
        if (primaryUser) {
          admins.unshift({
            id: primaryUser.id,
            fullName: primaryUser.user_metadata?.full_name || 'Primary Super Admin',
            email: PRIMARY_SUPER_ADMIN_EMAIL,
            role: 'super_admin',
            phone: '',
            agentCode: '',
            createdAt: primaryUser.created_at,
            lastSignInAt: primaryUser.last_sign_in_at || null,
            isPrimaryOwner: true,
          });
        }
      }

      return json({ success: true, admins });
    }

    // POST: Manage admin actions (body and action already parsed above)
    if (request.method === 'POST') {
      if (action === 'register-admin') {
        const fullName = String(body.fullName || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const role = String(body.role || 'admin').trim();

        if (!fullName || !email || !password) {
          return json({ error: 'Full name, email, and password are required.' }, 400);
        }

        if (password.length < 6) {
          return json({ error: 'Password must be at least 6 characters long.' }, 400);
        }

        if (!['admin', 'super_admin'].includes(role)) {
          return json({ error: 'Invalid role. Must be admin or super_admin.' }, 400);
        }

        // Create auth user via Supabase Admin API
        const { data: newUser, error: createError } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: {
            full_name: fullName,
            role,
          },
        });

        if (createError || !newUser?.user) {
          return json({ error: createError?.message || 'Failed to create admin user.' }, 400);
        }

        const userId = newUser.user.id;

        // Upsert into agents & profiles & wallets
        await Promise.all([
          admin.from('agents').upsert({
            id: userId,
            full_name: fullName,
            role,
          }, { onConflict: 'id' }),
          admin.from('profiles').upsert({
            id: userId,
            full_name: fullName,
          }, { onConflict: 'id' }),
          admin.from('wallets').upsert({
            id: userId,
            balance: 0,
          }, { onConflict: 'id', ignoreDuplicates: true }),
        ]);

        return json({
          success: true,
          message: `Admin ${fullName} (${email}) created successfully as ${role}.`,
          admin: {
            id: userId,
            fullName,
            email,
            role,
            createdAt: newUser.user.created_at,
          },
        });
      }

      // 2. UPDATE ROLE
      if (action === 'update-role') {
        const targetUserId = String(body.userId || '').trim();
        const newRole = String(body.role || '').trim();

        if (!targetUserId || !['admin', 'super_admin', 'agent'].includes(newRole)) {
          return json({ error: 'Valid userId and role are required.' }, 400);
        }

        // Look up target user email
        const { data: targetUser, error: getUserErr } = await admin.auth.admin.getUserById(targetUserId);
        if (getUserErr || !targetUser?.user) {
          return json({ error: 'Target user not found.' }, 404);
        }

        if (targetUser.user.email?.toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL.toLowerCase()) {
          return json({ error: 'The primary Super Admin owner role cannot be modified.' }, 403);
        }

        await Promise.all([
          admin.from('agents').update({ role: newRole, updated_at: new Date().toISOString() }).eq('id', targetUserId),
          admin.auth.admin.updateUserById(targetUserId, {
            user_metadata: { ...(targetUser.user.user_metadata || {}), role: newRole },
          }),
        ]);

        return json({ success: true, message: `Role updated to ${newRole}.` });
      }

      // 3. RESET PASSWORD
      if (action === 'reset-password') {
        const targetUserId = String(body.userId || '').trim();
        const newPassword = String(body.newPassword || '');

        if (!targetUserId || !newPassword || newPassword.length < 6) {
          return json({ error: 'User ID and a new password of at least 6 characters are required.' }, 400);
        }

        const { error: resetErr } = await admin.auth.admin.updateUserById(targetUserId, {
          password: newPassword,
        });

        if (resetErr) {
          return json({ error: resetErr.message || 'Failed to reset password.' }, 400);
        }

        return json({ success: true, message: 'Password updated successfully.' });
      }

      // 4. REVOKE ADMIN ACCESS
      if (action === 'revoke-admin') {
        const targetUserId = String(body.userId || '').trim();
        if (!targetUserId) return json({ error: 'User ID is required.' }, 400);

        const { data: targetUser } = await admin.auth.admin.getUserById(targetUserId);
        if (targetUser?.user?.email?.toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL.toLowerCase()) {
          return json({ error: 'Primary Super Admin access cannot be revoked.' }, 403);
        }

        // Demote role to agent
        await Promise.all([
          admin.from('agents').update({ role: 'agent', updated_at: new Date().toISOString() }).eq('id', targetUserId),
          admin.auth.admin.updateUserById(targetUserId, {
            user_metadata: { ...(targetUser?.user?.user_metadata || {}), role: 'agent' },
          }),
        ]);

        return json({ success: true, message: 'Admin access revoked. User demoted to regular agent.' });
      }

      return json({ error: `Unknown action: ${action}` }, 400);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err: unknown) {
    const error = err as Error;
    return json({ error: error.message || 'Server error occurred in manage-admins.' }, 500);
  }
});
