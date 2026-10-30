import { describe, it, expect } from 'vitest'
import { skillRegistry, getSkillIndex, getSkillContent, getSkillFiles } from '../../src/shared/skills'

describe('skills module', () => {
  describe('skillRegistry', () => {
    it('has all built-in skills loaded', () => {
      expect(skillRegistry.size).toBe(8)
      expect(skillRegistry.has('seo-audit')).toBe(true)
      expect(skillRegistry.has('accessibility')).toBe(true)
      expect(skillRegistry.has('performance')).toBe(true)
      expect(skillRegistry.has('debug')).toBe(true)
      expect(skillRegistry.has('chrome')).toBe(true)
      expect(skillRegistry.has('skill-creator')).toBe(true)
      expect(skillRegistry.has('dingtalk-docs')).toBe(true)
      expect(skillRegistry.has('canvas')).toBe(true)
    })

    it('each skill has name, description, dir, content', () => {
      for (const [, skill] of skillRegistry) {
        expect(skill.name).toBeTruthy()
        expect(skill.description).toBeTruthy()
        expect(skill.dir).toBeTruthy()
        expect(skill.content).toBeTruthy()
      }
    })
  })

  describe('getSkillIndex', () => {
    it('returns formatted list of all skills', () => {
      const result = getSkillIndex()
      expect(result).toContain('- seo-audit')
      expect(result).toContain('- accessibility')
      expect(result).toContain('- performance')
      expect(result).toContain('- debug')
      expect(result).toContain('- chrome')
      expect(result).toContain('- canvas')
    })

    it('respects disabledSkills', () => {
      const result = getSkillIndex(['seo-audit', 'debug'])
      expect(result).not.toContain('seo-audit')
      expect(result).not.toContain('- debug')
      expect(result).toContain('accessibility')
      expect(result).toContain('performance')
    })

    it('returns "(no skills available)" when all disabled', () => {
      const result = getSkillIndex(['seo-audit', 'accessibility', 'performance', 'debug', 'chrome', 'skill-creator', 'dingtalk-docs', 'canvas'])
      expect(result).toBe('(no skills available)')
    })
  })

  describe('getSkillContent', () => {
    it('returns content for valid name', () => {
      const content = getSkillContent('seo-audit')
      expect(content).toBeTruthy()
      expect(content).toContain('SEO')
    })

    it('returns null for disabled skill', () => {
      expect(getSkillContent('seo-audit', ['seo-audit'])).toBeNull()
    })

    it('returns null for unknown name', () => {
      expect(getSkillContent('nonexistent')).toBeNull()
    })

    it('returns content when name is not in disabled list', () => {
      expect(getSkillContent('seo-audit', ['debug'])).toBeTruthy()
    })
  })

  describe('getSkillFiles', () => {
    it('returns correct paths with SKILL.md content', () => {
      const files = getSkillFiles()
      expect(files['/skills/seo-audit/SKILL.md']).toContain('name: seo-audit')
      expect(files['/skills/accessibility/SKILL.md']).toContain('name: accessibility')
      expect(files['/skills/performance/SKILL.md']).toContain('name: performance')
      expect(files['/skills/debug/SKILL.md']).toContain('name: debug')
      expect(files['/skills/chrome/SKILL.md']).toContain('name: chrome')
      expect(files['/skills/skill-creator/SKILL.md']).toContain('name: skill-creator')
      expect(files['/skills/dingtalk-docs/SKILL.md']).toContain('name: dingtalk-docs')
      expect(files['/skills/canvas/SKILL.md']).toContain('name: canvas')
    })

    it('returns 8 files for 8 built-in skills', () => {
      expect(Object.keys(getSkillFiles()).length).toBe(8)
    })
  })
})
