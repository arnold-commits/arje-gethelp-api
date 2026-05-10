// ARJE /get-help triage relay
// Jotform form 261278593405059 → POST /api/triage → SendGrid Dynamic Templates
//
// Architecture:
//   1. Receive Jotform's webhook POST (multipart/form-data or x-www-form-urlencoded)
//   2. Map raw fields to canonical names via FIELD_MAP
//   3. Bot rejection: if honeypot field has any value, return 200 OK without firing emails
//   4. Triage: compute bucket (A/B/C/D) from canonical fields
//   5. Fire internal notification (Template 1) with all fields + triage_bucket + triage_action
//   6. Fire customer-facing template (2/3/4/5 based on bucket) with name + business
//   7. Return 200 OK to Jotform
//
// On any error: log to Vercel runtime logs, return 200 OK to Jotform anyway
// (so Jotform doesn't queue retry storms — we'd rather lose the email than dupe it)

export const runtime = 'nodejs'

// ──────────────────────────────────────────────────────────────────────
// Locked field mapping (Day 1 contract — see project knowledge)
// Jotform's webhook body uses HTML name attributes like q3_textbox1.
// Canonical names are what the triage logic and SendGrid templates use.
// ──────────────────────────────────────────────────────────────────────
const FIELD_MAP = {
  business_name:    'q3_textbox1',
  contact_name:     'q4_fullname2',     // composite: first/middle/last
  contact_email:    'q5_email3',
  industry:         'q7_dropdown5',
  industry_other:   'industry_other',
  current_state:    'q9_radio7',
  months_behind:    'q11_dropdown9',
  monthly_volume:   'q12_dropdown10',
  service_need:     'service_need',
  honeypot:         'q15_website',      // bot trap
}

// ──────────────────────────────────────────────────────────────────────
// SendGrid template config (Phase 4 batch result)
// ──────────────────────────────────────────────────────────────────────
const TEMPLATE_CONFIG = {
  internal:        { id: 'd-e9b2ff3b71464aaebcd359a75ff6e4e9', from_name: 'ARJE /get-help notification' },
  hot_cleanup:     { id: 'd-437300a3dc434cf6bc9b59d37585f2e6', from_name: 'Arnold Dizon' },
  warm_recurring:  { id: 'd-e8e068117636450d8c3e6c8e95718114', from_name: 'Arnold Dizon' },
  discovery:       { id: 'd-beada329ad014da2aa3acd76f87333c9', from_name: 'Arnold Dizon' },
  selfserve:       { id: 'd-aa60f167c5fc4fc183da5a68935fe5e0', from_name: 'Arnold Dizon' },
}

const FROM_EMAIL = 'arnold@arjebookkeeping.com'
const REPLY_TO   = 'arnold@arjebookkeeping.com'
const INTERNAL_RECIPIENT = 'arnold@arjebookkeeping.com'

// ──────────────────────────────────────────────────────────────────────
// Triage logic — maps canonical field values to bucket (A/B/C/D)
// Bucket logic locked May 9 (founder approved):
//   A — Hot Cleanup:    months_behind > 3 OR current_state = spreadsheets/manual
//   B — Warm Recurring: months_behind <= 3 AND service_need = monthly bookkeeping
//   C — Discovery:      service_need = "not sure / explore" OR vague signals
//   D — Selfserve:      monthly_volume < 50 OR service_need = templates only
// Order matters: D check first (clearest signal), then A, then B, fall through to C
// ──────────────────────────────────────────────────────────────────────
function computeTriage(fields) {
  const sn = (fields.service_need || '').toLowerCase()
  const mb = (fields.months_behind || '').toLowerCase()
  const cs = (fields.current_state || '').toLowerCase()
  const mv = (fields.monthly_volume || '').toLowerCase()

  // Bucket D — Selfserve: explicit templates-only or low volume
  if (sn.includes('template') || sn.includes('diy') || sn.includes('self')) {
    return { key: 'selfserve',      label: 'D — Selfserve',      action: 'No action needed — selfserve email handles routing to Gumroad/Etsy. Skim for outliers.' }
  }
  if (mv.includes('under 50') || mv.includes('< 50') || mv.includes('fewer than 50')) {
    return { key: 'selfserve',      label: 'D — Selfserve',      action: 'Volume below recurring-service threshold. Selfserve email queued. Skim for outliers.' }
  }

  // Bucket A — Hot Cleanup: behind on books or on manual systems
  if (mb.match(/[4-9]|10|11|12|year|month/) && mb.includes('month') && !mb.includes('caught up') && !mb.includes('0 month') && !mb.includes('1-3')) {
    return { key: 'hot_cleanup',    label: 'A — Hot Cleanup',    action: 'Send custom cleanup quote within 24 hrs. Quote per cleanup formula.' }
  }
  if (cs.includes('spreadsheet') || cs.includes('manual') || cs.includes('paper') || cs.includes('shoe')) {
    return { key: 'hot_cleanup',    label: 'A — Hot Cleanup',    action: 'On manual/spreadsheet system. Cleanup + QBO migration quote needed.' }
  }

  // Bucket B — Warm Recurring: current books + clear recurring intent
  if (sn.includes('monthly') || sn.includes('recurring') || sn.includes('ongoing')) {
    return { key: 'warm_recurring', label: 'B — Warm Recurring', action: 'Tier recommendation needed. Review volume and complexity, send tier match.' }
  }

  // Bucket C — Discovery: fall-through (uncertain, vague, or "not sure" signals)
  return { key: 'discovery',      label: 'C — Discovery',      action: 'Lead is exploring. Review submission, send tailored response (recommendation / questions / call link).' }
}

// ──────────────────────────────────────────────────────────────────────
// Map Jotform's raw payload into canonical fields
// Jotform sends composite fields (like fullname) with bracket syntax:
//   q4_fullname2[first]=Test, q4_fullname2[last]=User
// We collapse those to single strings.
// ──────────────────────────────────────────────────────────────────────
function extractFields(rawBody) {
  const fields = {}

  // Simple direct fields
  for (const [canonical, jotformName] of Object.entries(FIELD_MAP)) {
    if (canonical === 'contact_name') continue  // handled separately
    fields[canonical] = (rawBody[jotformName] || '').trim()
  }

  // Composite: contact_name from first/middle/last sub-fields
  const fnKey = FIELD_MAP.contact_name
  const first  = (rawBody[`${fnKey}[first]`]  || rawBody[`${fnKey}_first`]  || '').trim()
  const middle = (rawBody[`${fnKey}[middle]`] || rawBody[`${fnKey}_middle`] || '').trim()
  const last   = (rawBody[`${fnKey}[last]`]   || rawBody[`${fnKey}_last`]   || '').trim()
  fields.contact_name = [first, middle, last].filter(Boolean).join(' ')

  return fields
}

// ──────────────────────────────────────────────────────────────────────
// Parse Jotform's webhook body. Jotform sends as form-encoded by default,
// but check both common content types.
// ──────────────────────────────────────────────────────────────────────
async function parseJotformBody(req) {
  const contentType = req.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    return await req.json()
  }

  // form-urlencoded or multipart — Jotform commonly sends form-urlencoded
  // for webhooks; multipart only if file uploads present (we have none).
  const text = await req.text()
  const params = new URLSearchParams(text)
  const obj = {}
  for (const [key, value] of params.entries()) {
    obj[key] = value
  }
  return obj
}

// ──────────────────────────────────────────────────────────────────────
// SendGrid mail/send caller
// Uses fetch directly (no SDK dependency) for minimal footprint.
// ──────────────────────────────────────────────────────────────────────
async function sendTemplate({ to, templateId, fromName, dynamicData }) {
  const apiKey = process.env.SENDGRID_API_KEY
  if (!apiKey) {
    throw new Error('SENDGRID_API_KEY env var not set')
  }

  const body = {
    personalizations: [{
      to: [{ email: to }],
      dynamic_template_data: dynamicData,
    }],
    from: { email: FROM_EMAIL, name: fromName },
    reply_to: { email: REPLY_TO },
    template_id: templateId,
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`SendGrid mail/send failed: ${response.status} — ${errText}`)
  }

  return { ok: true, status: response.status }
}

// ──────────────────────────────────────────────────────────────────────
// Main webhook handler
// ──────────────────────────────────────────────────────────────────────
export async function POST(req) {
  const startTime = Date.now()

  try {
    // 1. Parse incoming webhook body
    const rawBody = await parseJotformBody(req)

    // 2. Map to canonical fields
    const fields = extractFields(rawBody)

    // 3. Bot rejection — silent 200 OK, no emails fired
    if (fields.honeypot && fields.honeypot.trim().length > 0) {
      console.log('[get-help-triage] BOT REJECTED — honeypot filled:', JSON.stringify({
        honeypot_value: fields.honeypot,
        contact_email: fields.contact_email,
        ip: req.headers.get('x-forwarded-for') || 'unknown',
      }))
      return new Response(JSON.stringify({ ok: true, route: 'bot-rejected' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    // 4. Sanity check — must have a contact email to send anything customer-facing
    if (!fields.contact_email || !fields.contact_email.includes('@')) {
      console.warn('[get-help-triage] missing or invalid contact_email — firing internal only:', JSON.stringify(fields))
      // Fall through and fire internal notification anyway so Arnold knows
    }

    // 5. Compute triage bucket
    const triage = computeTriage(fields)

    // 6. Fire internal notification (Template 1)
    const internalConfig = TEMPLATE_CONFIG.internal
    const submissionId = rawBody.submissionID || rawBody.submission_id || 'unknown'
    const submittedAt = new Date().toISOString()

    const internalData = {
      triage_bucket: triage.label,
      triage_action: triage.action,
      business_name: fields.business_name || '(not provided)',
      contact_name:  fields.contact_name  || '(not provided)',
      contact_email: fields.contact_email || '(not provided)',
      industry:      fields.industry      || '(not provided)',
      industry_other: fields.industry_other || '',
      current_state: fields.current_state || '(not provided)',
      months_behind: fields.months_behind || '(not provided)',
      monthly_volume: fields.monthly_volume || '(not provided)',
      service_need:  fields.service_need  || '(not provided)',
      honeypot_filled: false,  // we already returned above if it was filled
      honeypot_value: '',
      submission_url: `https://www.jotform.com/inbox/261278593405059/${submissionId}`,
      submitted_at:  submittedAt,
    }

    await sendTemplate({
      to: INTERNAL_RECIPIENT,
      templateId: internalConfig.id,
      fromName: internalConfig.from_name,
      dynamicData: internalData,
    })

    // 7. Fire customer-facing template (only if we have a valid contact email)
    let customerResult = { skipped: true, reason: 'no contact_email' }
    if (fields.contact_email && fields.contact_email.includes('@')) {
      const customerConfig = TEMPLATE_CONFIG[triage.key]
      const customerData = {
        contact_name:  fields.contact_name  || 'there',
        business_name: fields.business_name || 'your business',
        months_behind: fields.months_behind || '',
      }

      await sendTemplate({
        to: fields.contact_email,
        templateId: customerConfig.id,
        fromName: customerConfig.from_name,
        dynamicData: customerData,
      })
      customerResult = { sent: true, template: triage.key }
    }

    const elapsed = Date.now() - startTime
    console.log('[get-help-triage] success:', JSON.stringify({
      bucket: triage.key,
      contact_email: fields.contact_email,
      submission_id: submissionId,
      elapsed_ms: elapsed,
    }))

    return new Response(JSON.stringify({
      ok: true,
      bucket: triage.key,
      internal: 'sent',
      customer: customerResult,
      elapsed_ms: elapsed,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  } catch (err) {
    // Log error but return 200 OK so Jotform doesn't retry-storm
    console.error('[get-help-triage] error:', err.message, err.stack)
    return new Response(JSON.stringify({
      ok: false,
      error: 'relay error logged — see Vercel runtime logs',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

// ──────────────────────────────────────────────────────────────────────
// GET handler — health check / sanity ping
// curl https://[domain]/api/triage → returns the version + triage config
// ──────────────────────────────────────────────────────────────────────
export async function GET() {
  return new Response(JSON.stringify({
    ok: true,
    service: 'ARJE /get-help triage relay',
    version: '1.0.0',
    buckets: ['hot_cleanup', 'warm_recurring', 'discovery', 'selfserve'],
    timestamp: new Date().toISOString(),
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
