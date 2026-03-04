(function () {
  // タブ切り替え
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tab-btn').forEach(function (b) {
        b.classList.remove('active');
      });
      document.querySelectorAll('.tab-content').forEach(function (c) {
        c.classList.remove('active');
      });
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  // 確認しましたボタン
  document.getElementById('closeBtn').addEventListener('click', function () {
    window.close();
  });
})();
