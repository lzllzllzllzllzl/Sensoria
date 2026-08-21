const { query } = require('./db');
const {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  createSession,
  findUserBySessionToken,
  deleteSession
} = require('./auth');

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 2 * 1024 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function sessionToken(req) {
  return cookieValue(req, SESSION_COOKIE) ||
    (req.headers.authorization && req.headers.authorization.replace(/^Bearer\s+/i, ''));
}

function sessionCookie(token, maxAgeSec) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function userPublic(user) {
  return {
    id: user.id,
    email: user.email || null,
    phone: user.phone || null,
    createdAt: user.created_at
  };
}

async function fetchCloudData(user) {
  const [libRes, histRes] = await Promise.all([
    query(`SELECT id, name, mode, prompt, result, fp, saved_at FROM user_library WHERE user_id = $1 ORDER BY saved_at DESC`, [user.id]),
    query(`SELECT id, name, mode, result, viewed_at FROM user_history WHERE user_id = $1 ORDER BY viewed_at DESC LIMIT 50`, [user.id])
  ]);
  return {
    library: libRes.rows.map(r => ({
      id: String(r.id),
      name: r.name,
      mode: r.mode,
      prompt: r.prompt,
      result: r.result,
      fp: r.fp || [128, 128, 128],
      savedAt: r.saved_at ? new Date(r.saved_at).toLocaleString('zh-CN') : ''
    })),
    history: histRes.rows.map(r => ({
      id: String(r.id),
      name: r.name,
      mode: r.mode,
      result: r.result,
      viewedAt: r.viewed_at ? new Date(r.viewed_at).toLocaleString('zh-CN') : ''
    }))
  };
}

function validateAccount(account) {
  const s = String(account || '').trim();
  if (!s) return { error: '请输入邮箱或手机号' };
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const phoneRe = /^1[3-9]\d{9}$/;
  if (emailRe.test(s)) return { email: s };
  if (phoneRe.test(s)) return { phone: s };
  return { error: '请输入正确的邮箱或中国大陆手机号' };
}

async function handleAuthRegister(req, res) {
  let body;
  try { body = await readJSON(req); }
  catch { return sendJSON(res, 400, { error: '请求体不是合法 JSON' }); }

  const account = validateAccount(body.account);
  if (account.error) return sendJSON(res, 400, account);
  const password = String(body.password || '');
  if (password.length < 6) {
    return sendJSON(res, 400, { error: '密码至少 6 位' });
  }

  try {
    const exists = await query(
      `SELECT id FROM users WHERE email = $1 OR phone = $1`,
      [account.email || account.phone]
    );
    if (exists.rowCount > 0) {
      return sendJSON(res, 409, { error: '该账号已注册，请直接登录' });
    }

    const passwordHash = await hashPassword(password);
    const ins = await query(
      `INSERT INTO users (email, phone, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, phone, created_at`,
      [account.email || null, account.phone || null, passwordHash]
    );
    const user = ins.rows[0];
    const session = await createSession(user.id);

    const guestUid = String(body.guestUid || '').slice(0, 64) || null;
    if (guestUid) {
      await query(
        `UPDATE user_library SET user_id = $1, guest_uid = NULL WHERE guest_uid = $2`,
        [user.id, guestUid]
      );
      await query(
        `UPDATE user_history SET user_id = $1, guest_uid = NULL WHERE guest_uid = $2`,
        [user.id, guestUid]
      );
    }

    const library = Array.isArray(body.library) ? body.library : [];
    const history = Array.isArray(body.history) ? body.history : [];
    if (library.length > 0) {
      for (const it of library.slice(0, 50)) {
        await query(
          `INSERT INTO user_library (user_id, name, mode, prompt, result, fp)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            user.id,
            String(it.name || '未命名').slice(0, 200),
            it.mode === 'person' ? 'person' : 'product',
            String(it.prompt || '').slice(0, 500) || null,
            JSON.stringify(it.result || {}),
            JSON.stringify(it.fp || [128, 128, 128])
          ]
        );
      }
    }
    if (history.length > 0) {
      for (const it of history.slice(0, 50)) {
        await query(
          `INSERT INTO user_history (user_id, name, mode, result)
           VALUES ($1, $2, $3, $4)`,
          [
            user.id,
            String(it.name || '未命名').slice(0, 200),
            it.mode === 'person' ? 'person' : 'product',
            JSON.stringify(it.result || {})
          ]
        );
      }
    }

    const cloud = await fetchCloudData(user);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookie(session.token, 30 * 24 * 60 * 60)
    });
    res.end(JSON.stringify({ user: userPublic(user), ...cloud }));
  } catch (e) {
    console.error('注册失败:', e);
    sendJSON(res, 500, { error: '注册失败，请稍后重试' });
  }
}

async function handleAuthLogin(req, res) {
  let body;
  try { body = await readJSON(req); }
  catch { return sendJSON(res, 400, { error: '请求体不是合法 JSON' }); }

  const account = validateAccount(body.account);
  if (account.error) return sendJSON(res, 400, account);
  const password = String(body.password || '');
  if (!password) return sendJSON(res, 400, { error: '请输入密码' });

  try {
    const key = account.email || account.phone;
    const { rows } = await query(
      `SELECT id, email, phone, password_hash, created_at FROM users WHERE email = $1 OR phone = $1`,
      [key]
    );
    const user = rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return sendJSON(res, 401, { error: '账号或密码不正确' });
    }

    const session = await createSession(user.id);
    await query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [user.id]);
    const cloud = await fetchCloudData(user);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookie(session.token, 30 * 24 * 60 * 60)
    });
    res.end(JSON.stringify({ user: userPublic(user), ...cloud }));
  } catch (e) {
    console.error('登录失败:', e);
    sendJSON(res, 500, { error: '登录失败，请稍后重试' });
  }
}

async function handleAuthLogout(req, res) {
  const token = sessionToken(req);
  await deleteSession(token);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': sessionCookie('', 0)
  });
  res.end(JSON.stringify({ ok: true }));
}

async function handleMe(req, res) {
  const token = sessionToken(req);
  const user = await findUserBySessionToken(token);
  if (!user) return sendJSON(res, 401, { error: '未登录' });
  const cloud = await fetchCloudData(user);
  sendJSON(res, 200, { user: userPublic(user), ...cloud });
}

async function handleLibrary(req, res, method) {
  const token = sessionToken(req);
  const user = await findUserBySessionToken(token);
  const guestUid = (req.headers['x-guest-uid'] || '').slice(0, 64) || null;
  if (!user && !guestUid) {
    return sendJSON(res, 400, { error: '需要登录或提供游客标识' });
  }

  if (method === 'GET') {
    const where = user ? `user_id = $1` : `guest_uid = $1`;
    const params = user ? [user.id] : [guestUid];
    const { rows } = await query(
      `SELECT id, name, mode, prompt, result, fp, saved_at FROM user_library WHERE ${where} ORDER BY saved_at DESC LIMIT 50`,
      params
    );
    return sendJSON(res, 200, {
      library: rows.map(r => ({
        id: String(r.id),
        name: r.name,
        mode: r.mode,
        prompt: r.prompt,
        result: r.result,
        fp: r.fp || [128, 128, 128],
        savedAt: r.saved_at ? new Date(r.saved_at).toLocaleString('zh-CN') : ''
      }))
    });
  }

  if (method === 'POST') {
    let body;
    try { body = await readJSON(req); }
    catch { return sendJSON(res, 400, { error: '请求体不是合法 JSON' }); }
    const { rows } = await query(
      `INSERT INTO user_library (user_id, guest_uid, name, mode, prompt, result, fp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, mode, prompt, result, fp, saved_at`,
      [
        user ? user.id : null,
        user ? null : guestUid,
        String(body.name || '未命名').slice(0, 200),
        body.mode === 'person' ? 'person' : 'product',
        String(body.prompt || '').slice(0, 500) || null,
        JSON.stringify(body.result || {}),
        JSON.stringify(body.fp || [128, 128, 128])
      ]
    );
    const r = rows[0];
    return sendJSON(res, 201, {
      item: {
        id: String(r.id),
        name: r.name,
        mode: r.mode,
        prompt: r.prompt,
        result: r.result,
        fp: r.fp,
        savedAt: r.saved_at ? new Date(r.saved_at).toLocaleString('zh-CN') : ''
      }
    });
  }

  if (method === 'DELETE') {
    const idPart = String(req.url).split('/').pop();
    const id = Number(idPart);
    if (idPart !== '/api/library' && !id) {
      return sendJSON(res, 400, { error: '缺少条目 id' });
    }
    if (id) {
      const where = user ? `user_id = $1 AND id = $2` : `guest_uid = $1 AND id = $2`;
      const params = user ? [user.id, id] : [guestUid, id];
      await query(`DELETE FROM user_library WHERE ${where}`, params);
    } else {
      const where = user ? `user_id = $1` : `guest_uid = $1`;
      const params = user ? [user.id] : [guestUid];
      await query(`DELETE FROM user_library WHERE ${where}`, params);
    }
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 405, { error: 'Method Not Allowed' });
}

async function handleHistory(req, res, method) {
  const token = sessionToken(req);
  const user = await findUserBySessionToken(token);
  const guestUid = (req.headers['x-guest-uid'] || '').slice(0, 64) || null;
  if (!user && !guestUid) {
    return sendJSON(res, 400, { error: '需要登录或提供游客标识' });
  }

  if (method === 'GET') {
    const where = user ? `user_id = $1` : `guest_uid = $1`;
    const params = user ? [user.id] : [guestUid];
    const { rows } = await query(
      `SELECT id, name, mode, result, viewed_at FROM user_history WHERE ${where} ORDER BY viewed_at DESC LIMIT 50`,
      params
    );
    return sendJSON(res, 200, {
      history: rows.map(r => ({
        id: String(r.id),
        name: r.name,
        mode: r.mode,
        result: r.result,
        viewedAt: r.viewed_at ? new Date(r.viewed_at).toLocaleString('zh-CN') : '',
        time: r.viewed_at ? new Date(r.viewed_at).toLocaleString('zh-CN') : ''
      }))
    });
  }

  if (method === 'POST') {
    let body;
    try { body = await readJSON(req); }
    catch { return sendJSON(res, 400, { error: '请求体不是合法 JSON' }); }
    const { rows } = await query(
      `INSERT INTO user_history (user_id, guest_uid, name, mode, result)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, mode, result, viewed_at`,
      [
        user ? user.id : null,
        user ? null : guestUid,
        String(body.name || '未命名').slice(0, 200),
        body.mode === 'person' ? 'person' : 'product',
        JSON.stringify(body.result || body || {})
      ]
    );
    const r = rows[0];
    return sendJSON(res, 201, {
      item: {
        id: String(r.id),
        name: r.name,
        mode: r.mode,
        result: r.result,
        viewedAt: r.viewed_at ? new Date(r.viewed_at).toLocaleString('zh-CN') : '',
        time: r.viewed_at ? new Date(r.viewed_at).toLocaleString('zh-CN') : ''
      }
    });
  }

  return sendJSON(res, 405, { error: 'Method Not Allowed' });
}

module.exports = {
  sendJSON,
  handleAuthRegister,
  handleAuthLogin,
  handleAuthLogout,
  handleMe,
  handleLibrary,
  handleHistory
};
