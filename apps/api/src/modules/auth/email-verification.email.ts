export function verificationEmailContent(verificationUrl: string): { text: string; html: string } {
  return {
    text: [
      'Verify your email address',
      '',
      'You received this message because an account was created with this email address.',
      `Verify your email within 24 hours: ${verificationUrl}`,
      '',
      'If you did not create this account, you can ignore this email.',
    ].join('\n'),
    html: [
      '<!doctype html>',
      '<html><body style="font-family:Arial,sans-serif;color:#172033;line-height:1.5">',
      '<h1>Verify your email address</h1>',
      '<p>You received this message because an account was created with this email address.</p>',
      `<p><a href="${verificationUrl}">Verify email address</a></p>`,
      '<p>This link expires in 24 hours.</p>',
      '<p>If you did not create this account, you can ignore this email.</p>',
      '</body></html>',
    ].join(''),
  };
}
