export {
  DeviceTemplateCatalogue,
  DeviceTemplateError,
  type TemplateProblem,
  type TemplateSummary,
} from './catalogue.js';
export {
  applicableSensors,
  matchScore,
  matchTemplates,
  TEMPLATE_ID,
  validateTemplate,
  type DeviceTemplate,
  type SensorSpec,
  type TemplateMatch,
  type TemplateMatchResult,
} from './definition.js';
export { BUILT_IN_DEVICE_TEMPLATES } from './built-in.js';
export { loadDeviceTemplates, type LoadDeviceTemplatesOptions } from './loader.js';
export { templateFromDevice, type DeviceSensorRow, type FromDeviceOptions } from './from-device.js';
