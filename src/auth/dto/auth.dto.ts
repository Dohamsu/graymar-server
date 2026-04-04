import { z } from 'zod';

export const RegisterBodySchema = z.object({
  email: z
    .string({ error: '이메일을 입력해주세요.' })
    .email({ message: '올바른 이메일 형식을 입력해주세요.' })
    .max(255),
  password: z
    .string({ error: '비밀번호를 입력해주세요.' })
    .min(8, { message: '비밀번호는 8자 이상이어야 합니다.' })
    .max(128),
  nickname: z
    .string()
    .min(1, { message: '닉네임을 입력해주세요.' })
    .max(30, { message: '닉네임은 30자 이내로 입력해주세요.' })
    .optional(),
});

export const LoginBodySchema = z.object({
  email: z
    .string({ error: '이메일을 입력해주세요.' })
    .email({ message: '올바른 이메일 형식을 입력해주세요.' })
    .max(255),
  password: z
    .string({ error: '비밀번호를 입력해주세요.' })
    .min(1, { message: '비밀번호를 입력해주세요.' })
    .max(128),
});

export type RegisterBody = z.infer<typeof RegisterBodySchema>;
export type LoginBody = z.infer<typeof LoginBodySchema>;
