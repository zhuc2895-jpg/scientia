import { spawn } from 'node:child_process';

const WINDOWS_SECRET_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'SCIENTIA - DeepSeek API Key'
$form.Size = New-Object System.Drawing.Size(500, 190)
$form.StartPosition = 'CenterScreen'
$form.Topmost = $true
$label = New-Object System.Windows.Forms.Label
$label.Text = 'API Key 只在主进程中读取，不进入应用 renderer。'
$label.Location = New-Object System.Drawing.Point(18, 18)
$label.Size = New-Object System.Drawing.Size(450, 24)
$input = New-Object System.Windows.Forms.TextBox
$input.Location = New-Object System.Drawing.Point(18, 52)
$input.Size = New-Object System.Drawing.Size(450, 28)
$input.UseSystemPasswordChar = $true
$ok = New-Object System.Windows.Forms.Button
$ok.Text = '保存'
$ok.Location = New-Object System.Drawing.Point(300, 98)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = '取消'
$cancel.Location = New-Object System.Drawing.Point(392, 98)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.AddRange(@($label, $input, $ok, $cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($input.Text)
}
`;

export function captureSecretFromUser({
  platform = process.platform,
  spawnProcess = spawn,
  timeoutMs = 300000,
} = {}) {
  if (platform !== 'win32') {
    return Promise.reject(new Error('当前平台尚未提供原生安全输入。'));
  }
  return new Promise((resolve, reject) => {
    const child = spawnProcess('powershell.exe', ['-NoProfile', '-STA', '-Command', WINDOWS_SECRET_SCRIPT], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('API Key 输入超时。'));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const secret = stdout.trim();
      if (code === 0 && secret) resolve(secret);
      else reject(new Error(stderr.trim() || '已取消 API Key 输入。'));
    });
  });
}
