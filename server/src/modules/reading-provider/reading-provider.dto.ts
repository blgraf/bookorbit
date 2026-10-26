import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
export class ConnectReadingProviderDto {
  @IsOptional() @IsEmail() @MaxLength(320) email?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(1024) password?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(16384) cookies?: string;
}
export class EnableReadingProviderDto {
  @IsBoolean() enabled!: boolean;
}
export class ExcludeReadingProviderBookDto {
  @IsBoolean() excluded!: boolean;
}
export class LinkReadingProviderBookDto {
  @IsString() @MinLength(1) @MaxLength(128) resourceId!: string;
}
