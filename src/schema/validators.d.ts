// Типы для сгенерированного validators.js (Ajv standalone).
export interface ValidationError {
  instancePath: string
  schemaPath: string
  keyword: string
  params: Record<string, unknown>
  message?: string
}

export interface ValidateFn {
  (data: unknown): boolean
  errors?: ValidationError[] | null
}

export const validateProject: ValidateFn
export const validateIdea: ValidateFn
export const validateSettings: ValidateFn
export const validateStatus: ValidateFn
