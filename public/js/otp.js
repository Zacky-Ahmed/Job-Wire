// otp.js — auto-advance, backspace, arrows, and full-code paste.
(function () {
  var box = document.getElementById("otpBox");
  if (!box) return;
  var inputs = Array.prototype.slice.call(box.querySelectorAll("input"));

  inputs.forEach(function (inp, i) {
    inp.addEventListener("input", function () {
      inp.value = inp.value.replace(/\D/g, "").slice(0, 1);
      if (inp.value && i < inputs.length - 1) inputs[i + 1].focus();
      box.classList.remove("bad");
    });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Backspace" && !inp.value && i > 0) {
        inputs[i - 1].focus(); inputs[i - 1].value = ""; e.preventDefault();
      }
      if (e.key === "ArrowLeft" && i > 0) inputs[i - 1].focus();
      if (e.key === "ArrowRight" && i < inputs.length - 1) inputs[i + 1].focus();
    });
    inp.addEventListener("paste", function (e) {
      var d = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
      if (!d) return;
      e.preventDefault();
      d.split("").forEach(function (ch, x) { if (inputs[x]) inputs[x].value = ch; });
      inputs[Math.min(d.length, inputs.length - 1)].focus();
    });
  });
  inputs[0].focus();
})();
