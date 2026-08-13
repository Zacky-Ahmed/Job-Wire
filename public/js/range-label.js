// range-label.js — live label for the interval slider.
(function () {
  var input = document.getElementById("every");
  var out = document.getElementById("everyOut");
  if (!input || !out) return;
  function paint() {
    var n = Number(input.value);
    out.textContent = n + (n === 1 ? " minute" : " minutes");
  }
  input.addEventListener("input", paint);
  paint();
})();
