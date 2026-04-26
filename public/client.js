document.getElementById('connect').addEventListener('click', () => {
  const host = document.getElementById('host').value.trim();
  const port = document.getElementById('port').value.trim();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const privateKey = document.getElementById('privateKey').value;
  const passphrase = document.getElementById('passphrase').value;
  const init = document.getElementById('init').value;

  if (!host || !username) {
    alert('主机地址与用户名不能为空');
    return;
  }
  const payload = { host, port, username, password, privateKey, passphrase, init };
  sessionStorage.setItem('zephyr-ssh-opts', JSON.stringify(payload));
  window.location.href = '/terminal.html';
});