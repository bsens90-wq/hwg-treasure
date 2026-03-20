exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO = process.env.GITHUB_REPO;

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Environment variables not configured' }) };
  }

  // GitHub 파일 읽기 헬퍼
  async function readFile(path) {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    if (!res.ok) return { data: null, sha: null };
    const fileData = await res.json();
    const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
    return { data: JSON.parse(content), sha: fileData.sha };
  }

  // GitHub 파일 쓰기 헬퍼
  async function writeFile(path, data, sha, message) {
    const encodedContent = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const payload = { message, content: encodedContent, ...(sha && { sha }) };
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    return res.ok;
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { action } = body;

    // ── 설정 조회
    if (action === 'getConfig') {
      const { data } = await readFile('data/config.json');
      return { statusCode: 200, headers, body: JSON.stringify(data || {}) };
    }

    // ── 설정 저장 (관리자)
    if (action === 'setConfig') {
      const { config } = body;
      const { data, sha } = await readFile('data/config.json');
      const newConfig = { ...(data || {}), ...config };
      await writeFile('data/config.json', newConfig, sha, '설정 업데이트');
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── 사용자 이름 조회
    if (action === 'getUsername') {
      const { userCode } = body;
      const { data } = await readFile('data/users.json');
      const users = data || {};
      return { statusCode: 200, headers, body: JSON.stringify({ username: users[userCode] || null }) };
    }

    // ── 사용자 이름 등록
    if (action === 'setUsername') {
      const { userCode, username } = body;
      const { data, sha } = await readFile('data/users.json');
      const users = data || {};
      users[userCode] = username;
      await writeFile('data/users.json', users, sha, `사용자 이름 등록: ${userCode}`);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── 스탬프 조회
    if (action === 'getStamps') {
      const { userCode, all } = body;
      const { data } = await readFile('data/stamps.json');
      const stamps = data || {};
      if (all) {
        return { statusCode: 200, headers, body: JSON.stringify({ stamps }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ stamps: stamps[userCode] || [] }) };
    }

    // ── 스탬프 적립
    if (action === 'addStamp') {
      const { userCode, username, date } = body;
      const { data, sha } = await readFile('data/stamps.json');
      const stamps = data || {};
      if (!stamps[userCode]) stamps[userCode] = { username, records: [] };
      stamps[userCode].username = username;
      // 당일 중복 체크
      const already = stamps[userCode].records.some(r => r.date === date);
      if (already) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, duplicate: true }) };
      }
      stamps[userCode].records.push({ date });
      await writeFile('data/stamps.json', stamps, sha, `스탬프 적립: ${username} ${date}`);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, duplicate: false }) };
    }

    // ── 스탬프 초기화 (관리자)
    if (action === 'resetStamps') {
      const { targetUserCode } = body;
      const { data, sha } = await readFile('data/stamps.json');
      const stamps = data || {};
      if (targetUserCode) {
        delete stamps[targetUserCode];
      } else {
        // 전체 초기화
        Object.keys(stamps).forEach(k => delete stamps[k]);
      }
      await writeFile('data/stamps.json', stamps, sha, '스탬프 초기화');
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── 쿠폰 설정 조회
    if (action === 'getCoupons') {
      const { data } = await readFile('data/config.json');
      const config = data || {};
      return { statusCode: 200, headers, body: JSON.stringify({ coupons: config.coupons || [] }) };
    }

    // ── 쿠폰 설정 저장 (관리자)
    if (action === 'setCoupons') {
      const { coupons } = body;
      const { data, sha } = await readFile('data/config.json');
      const config = data || {};
      config.coupons = coupons;
      await writeFile('data/config.json', config, sha, '쿠폰 설정 업데이트');
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── 쿠폰 발급 (확률 처리)
    if (action === 'issueCoupon') {
      const { userCode, username, date } = body;

      // 설정 읽기
      const { data: configData } = await readFile('data/config.json');
      const config = configData || {};
      const coupons = config.coupons || [];

      // 발급 현황 읽기
      const { data: issuedData, sha: issuedSha } = await readFile('data/coupons_issued.json');
      const issued = issuedData || {};

      const wonCoupons = [];

      for (const coupon of coupons) {
        // 수량 체크
        const issuedCount = (issued[coupon.name] || []).length;
        if (coupon.limit > 0 && issuedCount >= coupon.limit) continue;

        // 확률 체크
        const rand = Math.random() * 100;
        if (rand <= coupon.probability) {
          // 발급
          if (!issued[coupon.name]) issued[coupon.name] = [];
          issued[coupon.name].push({ userCode, username, date });
          wonCoupons.push(coupon.name);
        }
      }

      if (wonCoupons.length > 0) {
        await writeFile('data/coupons_issued.json', issued, issuedSha, `쿠폰 발급: ${username} ${wonCoupons.join(',')}`);

        // 사용자 쿠폰함에도 저장
        const { data: userCouponData, sha: userCouponSha } = await readFile('data/user_coupons.json');
        const userCoupons = userCouponData || {};
        if (!userCoupons[userCode]) userCoupons[userCode] = { username, coupons: [] };
        wonCoupons.forEach(name => {
          userCoupons[userCode].coupons.push({ name, date, used: false });
        });
        await writeFile('data/user_coupons.json', userCoupons, userCouponSha, `사용자 쿠폰 저장: ${username}`);
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, wonCoupons }) };
    }

    // ── 사용자 쿠폰함 조회
    if (action === 'getUserCoupons') {
      const { userCode, all } = body;
      const { data } = await readFile('data/user_coupons.json');
      const userCoupons = data || {};
      if (all) {
        return { statusCode: 200, headers, body: JSON.stringify({ userCoupons }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ coupons: userCoupons[userCode]?.coupons || [] }) };
    }

    // ── 전체 사용자 현황 조회 (관리자)
    if (action === 'getAllStatus') {
      const { data: stampsData } = await readFile('data/stamps.json');
      const { data: couponData } = await readFile('data/user_coupons.json');
      const { data: usersData } = await readFile('data/users.json');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          stamps: stampsData || {},
          userCoupons: couponData || {},
          users: usersData || {}
        })
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (error) {
    console.error('Treasure proxy error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: `Internal server error: ${error.message}` }) };
  }
};
