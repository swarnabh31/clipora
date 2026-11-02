// Worker timers are not throttled when the recorder window is in the background.
let id = 0;
onmessage = (e) => {
  clearInterval(id);
  if (e.data && e.data.interval) id = setInterval(() => postMessage(0), e.data.interval);
};
