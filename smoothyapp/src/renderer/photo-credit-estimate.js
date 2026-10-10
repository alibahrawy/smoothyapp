import catalog from '../shared/photo-catalog.json';
import imagePricing from '../shared/photo-image-pricing.json';

// Display-only estimate. Billing stays on the server, using actual usage and
// costToCredits ($1 = 1,000 credits, rounded UP to 5 per accepted image).
const credits = dollars => Math.ceil((dollars * 1000 - 1e-8) / 5) * 5;
export function estimatePhotoCredits({ model, imageSize = '1K', references = 0, promptLength = 0, count = 1 }) {
  const caps = catalog.MODEL_CAPABILITIES[model];
  if (!caps) return null;
  const size = caps.supportsImageSize ? imageSize : '1K';
  let low, high;
  if (caps.api !== 'images') {
    const rates = catalog.IMAGE_TOKEN_PRICING[model];
    if (!rates) return null;
    const google = model.startsWith('google/');
    const output = google ? (model === 'google/gemini-3-pro-image' ? (size === '4K' ? 2000 : 1120) : ({ '1K': 1120, '2K': 1680, '4K': 2520 }[size] || 1120)) : 1000;
    const input = Math.ceil(promptLength / 4);
    low = (input * rates.input + output * rates.output) / 1e6;
    // Text/reasoning and reference token counts vary; GPT also chooses quality.
    high = ((input + references * 4096) * rates.input + (google ? output + 1000 : 9000) * rates.output) / 1e6;
  } else {
    const rates = imagePricing.models[model];
    if (!rates) return null;
    const outputs = rates.filter(rate => rate.billable === 'output_image');
    const tokenOutput = outputs.filter(rate => rate.unit === 'token');
    const megapixel = outputs.find(rate => rate.unit === 'megapixel');
    if (tokenOutput.length) {
      const inputText = rates.find(rate => rate.billable === 'input_text' && rate.unit === 'token')?.cost_usd || 0;
      const inputImage = rates.find(rate => rate.billable === 'input_image' && rate.unit === 'token')?.cost_usd || 0;
      const outputLow = Math.min(...tokenOutput.map(rate => rate.cost_usd));
      const outputHigh = Math.max(...tokenOutput.map(rate => rate.cost_usd));
      const prompt = Math.ceil(promptLength / 4) * inputText;
      const sizeFactor = size === '4K' ? 3 : size === '2K' ? 1.5 : 1;
      low = prompt + references * 1024 * inputImage + 500 * outputLow * sizeFactor;
      high = prompt + references * 4096 * inputImage + 2500 * outputHigh * sizeFactor;
    } else if (megapixel) {
      // These requests omit dimensions/resolution. Allow 1–2 output MP and
      // 1–4 input MP per reference, rather than claiming a precise pixel cost.
      low = megapixel.cost_usd; high = low * 2;
      const input = rates.find(rate => rate.billable === 'input_image' && rate.unit === 'megapixel');
      if (input) { low += input.cost_usd * references; high += input.cost_usd * references * 4; }
    } else {
      const variants = outputs.filter(rate => !rate.variant || rate.variant.toLowerCase() === size.toLowerCase() || rate.variant.toLowerCase().endsWith(`_${size.toLowerCase()}`));
      // Riverflow advertises 4K support but publishes no 4K tariff. Do not
      // silently apply its 1K rate to that resolution.
      if (model === 'sourceful/riverflow-v2-fast' && size === '4K') return null;
      const sized = variants.filter(rate => rate.variant);
      const applicable = sized.length ? sized : variants;
      if (!applicable.length) return null;
      low = Math.min(...applicable.map(rate => rate.cost_usd)); high = Math.max(...applicable.map(rate => rate.cost_usd));
      const input = rates.find(rate => rate.billable === 'input_image' && rate.unit === 'image');
      if (input) { low += input.cost_usd * references; high += input.cost_usd * references; }
      // Optional fonts / super-resolution references are not sent by this UI.
    }
  }
  const images = Math.max(1, count);
  return { low: credits(low) * images, high: credits(high) * images, count: images };
}

export function formatPhotoEstimate(estimate) {
  if (!estimate) return 'Estimate unavailable';
  const range = estimate.low === estimate.high ? estimate.low.toLocaleString() : `${estimate.low.toLocaleString()}–${estimate.high.toLocaleString()}`;
  return `≈ ${range} credits${estimate.count > 1 ? ' total' : ''}`;
}
