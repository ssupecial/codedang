import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService, type JwtVerifyOptions } from '@nestjs/jwt'
import { Cache } from 'cache-manager'
import type { Response } from 'express'
import {
  JwtAuthService,
  type JwtObject,
  type JwtPayload,
  type JwtTokens
} from '@libs/auth'
import { refreshTokenCacheKey } from '@libs/cache'
import {
  ACCESS_TOKEN_EXPIRE_TIME,
  REFRESH_TOKEN_COOKIE_OPTIONS,
  REFRESH_TOKEN_EXPIRE_TIME
} from '@libs/constants'
import {
  InvalidJwtTokenException,
  UnidentifiedException
} from '@libs/exception'
import { PrismaService } from '@libs/prisma'
import { UserService } from '@client/user/user.service'
import type { LoginUserDto } from './dto/login-user.dto'
import type { GithubUser } from './interface/social-user.interface'

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
    private readonly jwtAuthService: JwtAuthService,
    private readonly userService: UserService,
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache
  ) {}

  async issueJwtTokens(
    loginUserDto: LoginUserDto,
    isSocialUser?: boolean
  ): Promise<JwtTokens> {
    const user = await this.userService.getUserCredential(loginUserDto.username)
    if (
      !(await this.jwtAuthService.isValidUser(
        user,
        loginUserDto.password,
        isSocialUser
      ))
    ) {
      throw new UnidentifiedException('username or password')
    }
    await this.userService.updateLastLogin(user.username)

    return await this.createJwtTokens(user.id, user.username)
  }

  async updateJwtTokens(refreshToken: string): Promise<JwtTokens> {
    const { userId, username } = await this.verifyJwtToken(refreshToken)
    if (!(await this.isValidRefreshToken(refreshToken, userId))) {
      throw new InvalidJwtTokenException('Unidentified refresh token')
    }
    return await this.createJwtTokens(userId, username)
  }

  async verifyJwtToken(
    token: string,
    options: JwtVerifyOptions = {}
  ): Promise<JwtObject> {
    const jwtVerifyOptions = {
      secret: this.config.get('JWT_SECRET'),
      ...options
    }
    try {
      return await this.jwtService.verifyAsync(token, jwtVerifyOptions)
    } catch (error) {
      throw new InvalidJwtTokenException(error.message)
    }
  }

  async isValidRefreshToken(refreshToken: string, userId: number) {
    const cachedRefreshToken = await this.cacheManager.get(
      refreshTokenCacheKey(userId)
    )
    if (cachedRefreshToken !== refreshToken) {
      return false
    }
    return true
  }

  async createJwtTokens(userId: number, username: string): Promise<JwtTokens> {
    const payload: JwtPayload = { userId, username }
    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn: ACCESS_TOKEN_EXPIRE_TIME
    })
    const refreshToken = await this.jwtService.signAsync(payload, {
      expiresIn: REFRESH_TOKEN_EXPIRE_TIME
    })

    await this.cacheManager.set(
      refreshTokenCacheKey(userId),
      refreshToken,
      REFRESH_TOKEN_EXPIRE_TIME * 1000 // milliseconds
    )

    return { accessToken, refreshToken }
  }

  async deleteRefreshToken(userId: number) {
    return await this.cacheManager.del(refreshTokenCacheKey(userId))
  }

  async githubLogin(res: Response, githubUser: GithubUser) {
    const { githubId } = githubUser

    const userOAuth = await this.prisma.userOAuth.findFirst({
      where: {
        id: parseInt(githubId),
        provider: 'github'
      }
    })

    if (!userOAuth) {
      // 소셜 회원가입 페이지 url 전달
      // TODO: 소셜 회원가입 페이지 url 확정되면 여기에 삽입
      return {
        signUpUrl: `https://codedang.com/social-signup?provider=github&id=${githubUser.githubId}}&email=${githubUser.email}`
      }
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: userOAuth.userId
      }
    })

    const jwtTokens = await this.issueJwtTokens(
      {
        username: user.username,
        password: user.password
      },
      true
    )

    res.setHeader('authorization', `Bearer ${jwtTokens.accessToken}`)
    res.cookie(
      'refresh_token',
      jwtTokens.refreshToken,
      REFRESH_TOKEN_COOKIE_OPTIONS
    )
  }
}
